"""Read STEP assembly geometry and original CAD face colours via OpenCascade."""
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_LabelSequence
from OCP.XCAFDoc import XCAFDoc_DocumentTool,XCAFDoc_ColorSurf,XCAFDoc_ColorGen
from OCP.Quantity import Quantity_ColorRGBA
import cadquery as cq

def colored_faces(path):
 doc=TDocStd_Document(TCollection_ExtendedString('cad'));r=STEPCAFControl_Reader();r.SetColorMode(True);assert r.ReadFile(str(path))==1;r.Transfer(doc)
 st=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main());ct=XCAFDoc_DocumentTool.ColorTool_s(doc.Main());labels=TDF_LabelSequence();st.GetFreeShapes(labels)
 def color(shape):
  q=Quantity_ColorRGBA()
  for kind in (XCAFDoc_ColorSurf,XCAFDoc_ColorGen):
   if ct.GetColor(shape,kind,q):
    c=q.GetRGB();return [c.Red(),c.Green(),c.Blue()]
  return None
 for i in range(1,labels.Length()+1):
  shape=cq.Shape.cast(st.GetShape_s(labels.Value(i)))
  for solid in shape.Solids():
   base=color(solid.wrapped)
   for face in solid.Faces():yield face,color(face.wrapped) or base
