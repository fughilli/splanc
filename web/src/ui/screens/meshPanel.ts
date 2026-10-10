import { parseMesh, type MeshOverlay } from "../../geom/mesh";
import { mapStore } from "../../store/mapStore";
import { Button, toast } from "../kit";

/** Manual digital-twin alignment; no changes to the measured LED coordinates. */
export function MeshPanel(id: string, initial: MeshOverlay | null, preview: (mesh: MeshOverlay | null) => void): HTMLElement {
  let mesh = initial ? structuredClone(initial) : null;
  const panel = document.createElement("details");
  panel.className = "k-card";
  const title = document.createElement("summary");
  title.textContent = "Digital twin · mesh overlay";
  const help = document.createElement("p");
  help.textContent = "Import an OBJ or STL after scanning. Align the gray mesh manually; positions are in meters and rotations in degrees. Materials and colors are ignored. Export the library to include the mesh; device maps contain LEDs and topology only.";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".obj,.stl";
  file.setAttribute("aria-label", "Import digital twin mesh (OBJ or STL)");
  const fields = document.createElement("div");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  panel.append(title, help, file, fields, status);
  const change = (): void => {
    preview(mesh);
    status.textContent = "Unsaved mesh alignment";
  };
  function rebuild(): void {
    fields.replaceChildren();
    if (!mesh) { status.textContent = "No mesh attached"; return; }
    status.textContent = `${mesh.name} · ${mesh.triangles.length.toLocaleString()} triangles`;
    for (const key of ["translation", "rotation", "scale"] as const) {
      const count = key === "scale" ? 1 : 3;
      for (let axis = 0; axis < count; axis++) {
        const label = document.createElement("label");
        label.style.display = "inline-flex";
        label.style.gap = "0.5em";
        label.style.margin = "0.5em";
        label.textContent = key === "scale" ? "Scale" : `${key === "translation" ? "Position" : "Rotation"} ${"XYZ"[axis]}`;
        const input = document.createElement("input");
        input.type = "number";
        input.step = key === "rotation" ? "1" : "0.01";
        input.style.width = "6em";
        if (key === "scale") input.min = "0.000001";
        input.value = String(key === "scale" ? mesh.scale : mesh[key][axis]);
        input.addEventListener("input", () => {
          const value = input.valueAsNumber;
          if (!mesh || !Number.isFinite(value) || (key === "scale" && value <= 0)) return;
          if (key === "scale") mesh.scale = value;
          else mesh[key][axis] = value;
          change();
        });
        label.append(input); fields.append(label);
      }
    }
    const visible = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox"; check.checked = mesh.visible;
    visible.append(check, " Show mesh");
    check.addEventListener("change", () => { if (mesh) { mesh.visible = check.checked; change(); } });
    fields.append(visible, Button({ label: "Reset alignment", onClick: () => {
      if (!mesh) return;
      mesh.translation = [0, 0, 0]; mesh.rotation = [0, 0, 0]; mesh.scale = 1;
      rebuild(); change();
    } }), Button({ label: "Save mesh", onClick: () => {
      void mapStore.setMesh(id, mesh).then(() => { status.textContent = "Mesh saved"; }).catch(e => toast(String(e), { error: true }));
    } }), Button({ label: "Remove mesh", variant: "danger", onClick: () => {
      void mapStore.setMesh(id, null).then(() => { mesh = null; preview(null); rebuild(); }).catch(e => toast(String(e), { error: true }));
    } }));
  }
  file.addEventListener("change", () => {
    const selected = file.files?.[0];
    if (!selected) return;
    if (selected.size > 20 * 1024 * 1024) { toast("Mesh file exceeds 20 MB; simplify it before importing", { error: true }); file.value = ""; return; }
    void selected.arrayBuffer().then(bytes => {
      mesh = parseMesh(new Uint8Array(bytes), selected.name);
      rebuild(); change();
    }).catch(e => toast(String(e), { error: true })).finally(() => { file.value = ""; });
  });
  rebuild();
  return panel;
}
