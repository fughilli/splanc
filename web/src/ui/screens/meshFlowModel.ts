/**
 * The "Create a mesh" flow's steps and its wording for a fixture's refusal (pure; the
 * screen is meshFlow.ts).
 */

export type MeshFlowMode = "new" | "add";
export type MeshFlowStep = "intro" | "pick" | "name" | "setup" | "joined";

/** One step per screen: a new mesh is introduced and named; adding skips both. */
export function flowSteps(mode: MeshFlowMode): MeshFlowStep[] {
  return mode === "new" ? ["intro", "pick", "name", "setup", "joined"] : ["pick", "setup", "joined"];
}

/** A provision refusal (MeshAdminError name) as what to do about it. */
export function provisionFailureText(code: string, fallback: string): string {
  switch (code) {
    case "MESH_ADMIN_LOCKED":
      return "It already belongs to a mesh made on another phone. Remove it there first, or reset its mesh from its USB console (MESH LEAVE).";
    case "MESH_ADMIN_UNSUPPORTED":
      return "This fixture can't join a mesh (its firmware has no device key yet). Update it, then try again.";
    case "MESH_ADMIN_BUSY":
    case "MESH_ADMIN_LOCKED_OUT":
      return "It was busy. Try again in a moment.";
    case "NO_KEY":
      return "Its mesh turned on but it didn't report its key. Try again.";
    default:
      return `It said: ${fallback}`;
  }
}
