import { IsString, Length, Matches } from "class-validator";

/**
 * `:cid` route param. A Canton contract id is hex with a `00` prefix; the character class is
 * deliberately a little wider (test fakes use `pp-0001`) but never wide enough to smuggle a
 * path or a query into an upstream URL. Shared by the user and the admin settle routes.
 */
export class PayoutCidParamDto {
  @IsString()
  @Length(1, 1024)
  @Matches(/^[A-Za-z0-9._:-]+$/, { message: "cid must be a contract id" })
  cid!: string;
}
