# CSD18540Q5B 3D model

EasyEDA C86513 model ID ed84f5dd80b4414bacf3798e6484c98f has an available OBJ
but its STEP endpoint returns 404. The local WRL was converted from that exact
OBJ using atopile-easyeda2kicad 0.9.9's generate_wrl_model, preserving materials.
Existing footprint rotation (270 degrees about Z) is preserved. This repairs
3D visualization; the model is a mesh and does not provide a solid STEP assembly.

Source: https://modules.easyeda.com/3dmodel/ed84f5dd80b4414bacf3798e6484c98f
