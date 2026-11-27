/**
 * The `.fxb` format check (D-541 / D-557). The compiler stamps each effect with
 * the OLDEST format that describes it (byte 4 of the header): 1 for everything
 * old firmware runs, 2 once an effect uses a newer uniform widget (`: vector`,
 * `: direction`; later the mat3 `: transform2d` gizmo and persisted textures).
 * The device reports the newest format it runs (welcome.fxb_format; 0 on
 * firmware too old to say). Checking here turns the device's bare `bad_fxb`
 * into "update the firmware" before anything is sent.
 */

/** The format byte of an `.fxb` (0 when the buffer is too short to tell). */
export function fxbFormatOf(fxb: Uint8Array): number {
  return fxb.length > 4 ? (fxb[4] ?? 0) : 0;
}

/** Why the device can't run this effect, or null when it can (or can't say:
 * firmware that reports format 0 predates the field and is left to answer). */
export function fxbFormatProblem(fxb: Uint8Array, deviceFormat: number | undefined): string | null {
  const need = fxbFormatOf(fxb);
  const have = deviceFormat ?? 0;
  if (have <= 0 || need <= have) return null;
  return (
    `this effect uses controls (vector or direction pads) that need newer firmware ` +
    `(effect format ${need}, the device runs format ${have}): update the device's firmware`
  );
}
