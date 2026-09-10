import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  AckPolicy,
  DeliverPolicy,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  type StreamInfo,
} from "@nats-io/jetstream";
import { connect, nanos, type NatsConnection } from "@nats-io/transport-node";

import { Config } from "../config";
import type { NatsSubject } from "../types";

/** All domain events live on one JetStream stream per network: `TRUTHORACLE_<APP_NETWORK>`. */
export const DOMAIN_SUBJECTS = ["truthoracle.>"];

export interface ConsumedMessage {
  subject: string;
  data: unknown;
  redelivered: boolean;
  ack(): void;
  nak(delayMs?: number): void;
  term(): void;
}

export type ConsumeHandler = (msg: ConsumedMessage) => Promise<void>;

const ACK_WAIT_MS = 30_000;
const MAX_DELIVER = 20;
const NAK_DELAY_MS = 5_000;

@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsService.name);
  readonly streamName: string;
  private nc?: NatsConnection;
  private jsm?: JetStreamManager;
  private js?: JetStreamClient;
  private readonly loops = new Map<string, { messages: ConsumerMessages; done: Promise<void> }>();

  constructor(private readonly config: Config) {
    this.streamName = `TRUTHORACLE_${config.appNetwork.toUpperCase()}`;
  }

  async onModuleInit(): Promise<void> {
    this.nc = await connect({
      servers: this.config.natsUrl,
      name: "truthoracle-backend",
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2_000,
    });
    this.logger.log(`connected to ${this.nc.getServer()} (nats-server v${this.nc.info?.version ?? "?"})`);
    void this.nc.closed().then((err) => {
      if (err) this.logger.error(`connection closed: ${err.message}`);
    });

    this.jsm = await jetstreamManager(this.nc);
    this.js = this.jsm.jetstream();
    const info = await this.ensureStream(this.streamName, DOMAIN_SUBJECTS);
    this.logger.log(
      `stream ${info.config.name} ready (subjects: ${info.config.subjects.join(", ")}; messages: ${info.state.messages})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const [durable, loop] of this.loops) {
      try {
        loop.messages.stop();
        await loop.done;
      } catch (err) {
        this.logger.warn(`consumer ${durable} did not stop cleanly: ${(err as Error).message}`);
      }
    }
    this.loops.clear();
    if (!this.nc) return;
    try {
      await this.nc.drain();
    } catch {
      await this.nc.close();
    }
    this.logger.log("connection drained and closed");
  }

  isConnected(): boolean {
    return this.nc !== undefined && !this.nc.isClosed();
  }

  get jetstream(): JetStreamClient {
    if (!this.js) throw new Error("NATS JetStream client not initialised");
    return this.js;
  }

  get manager(): JetStreamManager {
    if (!this.jsm) throw new Error("NATS JetStream manager not initialised");
    return this.jsm;
  }

  /** Publish a JSON domain event; JetStream acks once the stream has persisted it. */
  async publish(subject: NatsSubject, payload: object, opts?: { msgId?: string }): Promise<void> {
    await this.jetstream.publish(subject, JSON.stringify(payload), opts?.msgId ? { msgID: opts.msgId } : undefined);
  }

  /**
   * Start a background loop on a durable, explicit-ack pull consumer filtered to `filterSubject`.
   * Idempotent per durable name. A handler that throws NAKs the message with a delay; after
   * MAX_DELIVER attempts JetStream stops redelivering it.
   */
  async consume(durable: string, filterSubject: string, handler: ConsumeHandler): Promise<void> {
    const name = sanitizeDurable(durable);
    if (this.loops.has(name)) return;

    await this.ensureConsumer(name, filterSubject);
    const consumer = await this.jetstream.consumers.get(this.streamName, name);
    const messages = await consumer.consume({ max_messages: 10 });

    const done = (async () => {
      try {
        for await (const m of messages) {
          await this.dispatch(name, m, handler);
        }
      } catch (err) {
        if (this.isConnected()) this.logger.error(`consumer ${name} loop ended: ${(err as Error).message}`);
      }
    })();

    this.loops.set(name, { messages, done });
    this.logger.log(`consumer ${name} on ${filterSubject} started`);
  }

  private async dispatch(name: string, m: JsMsg, handler: ConsumeHandler): Promise<void> {
    let data: unknown;
    try {
      data = m.json<unknown>();
    } catch {
      this.logger.warn(`consumer ${name}: non-JSON payload on ${m.subject} terminated`);
      m.term();
      return;
    }
    let settled = false;
    const wrapped: ConsumedMessage = {
      subject: m.subject,
      data,
      redelivered: m.redelivered,
      ack: () => {
        settled = true;
        m.ack();
      },
      nak: (delayMs?: number) => {
        settled = true;
        m.nak(delayMs ?? NAK_DELAY_MS);
      },
      term: () => {
        settled = true;
        m.term();
      },
    };
    try {
      await handler(wrapped);
      if (!settled) m.ack();
    } catch (err) {
      this.logger.warn(`consumer ${name}: handler failed on ${m.subject}: ${(err as Error).message}`);
      if (!settled) m.nak(NAK_DELAY_MS);
    }
  }

  private async ensureConsumer(name: string, filterSubject: string): Promise<void> {
    const jsm = this.manager;
    try {
      const existing = await jsm.consumers.info(this.streamName, name);
      if (existing.config.filter_subject !== filterSubject) {
        await jsm.consumers.update(this.streamName, name, { filter_subject: filterSubject });
      }
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await jsm.consumers.add(this.streamName, {
      durable_name: name,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: filterSubject,
      ack_wait: nanos(ACK_WAIT_MS),
      max_deliver: MAX_DELIVER,
    });
  }

  /** Idempotent: creates the stream when missing, extends its subjects when they drifted. */
  private async ensureStream(name: string, subjects: string[]): Promise<StreamInfo> {
    const jsm = this.manager;
    let existing: StreamInfo | undefined;
    try {
      existing = await jsm.streams.info(name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (existing) {
      const missing = subjects.filter((s) => !existing.config.subjects.includes(s));
      if (missing.length === 0) return existing;
      return jsm.streams.update(name, {
        ...existing.config,
        subjects: [...existing.config.subjects, ...missing],
      });
    }
    try {
      return await jsm.streams.add({
        name,
        subjects,
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: nanos(7 * 24 * 60 * 60 * 1000),
        duplicate_window: nanos(2 * 60 * 1000),
      });
    } catch (err) {
      // JetStream allows exactly one stream per subject. A stream created under another name
      // (an older deployment, a shared dev server) that owns `truthoracle.>` blocks ours; say so
      // instead of surfacing "subjects overlap with an existing stream" with no context.
      if (isSubjectOverlap(err)) {
        throw new Error(
          `Refusing to boot: JetStream would not create stream ${name} because another stream already owns ${subjects.join(", ")} on ${this.config.natsUrl} (${(err as Error).message}). Rename or delete that stream — docs/RUNBOOK.md §4.`,
          { cause: err },
        );
      }
      throw err;
    }
  }
}

/** JetStream API error 10065: the requested subjects overlap with another stream. */
function isSubjectOverlap(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { err_code?: unknown; message?: unknown };
  return e.err_code === 10065 || (typeof e.message === "string" && /subjects overlap/i.test(e.message));
}

/** Consumer names may not contain `.`, `*`, `>`, whitespace or path separators. */
export function sanitizeDurable(name: string): string {
  return name.replace(/[.*>\s/\\]+/g, "_");
}

/** JetStream reports a missing stream/consumer as API error 404 (err_code 10059 / 10014). */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; err_code?: unknown; message?: unknown };
  return (
    e.err_code === 10059 ||
    e.err_code === 10014 ||
    e.code === 404 ||
    (typeof e.message === "string" && /(stream|consumer) not found/i.test(e.message))
  );
}
