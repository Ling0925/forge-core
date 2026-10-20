import { ForgeError } from "../shared/errors";
/** Authored, safe CLI/transport diagnostics; never wrap raw system/provider errors. */
export const hostError = (message: string) =>
  new ForgeError("invalid_input", message);
