"""Exact static-state check for conservative track-only native model updates."""
import hashlib,re

def split_board(text):
 static=[];tracks={};depth=0;quoted=False;escape=False;start=0;last=0
 for i,c in enumerate(text):
  if quoted:
   if escape:escape=False
   elif c=='\\':escape=True
   elif c=='"':quoted=False
   continue
  if c=='"':quoted=True;continue
  if c=='(':
   if depth==1:start=i
   depth+=1
  elif c==')':
   depth-=1
   if depth<0:raise ValueError('Unbalanced board')
   if depth==1:
    node=text[start:i+1];kind=re.match(r'\(([^\s()]+)',node)[1]
    if kind in ('segment','via','arc'):
     m=re.search(r'\(uuid\s+"([^"]+)"\)',node)
     if not m or m[1] in tracks:raise ValueError('Missing/duplicate copper UUID')
     tracks[m[1]]=node
    else:static.append(node)
 if depth or quoted:raise ValueError('Incomplete board')
 # Preserve every byte INSIDE non-copper nodes, including quoted whitespace.
 # Ignore only formatting gaps outside complete top-level expressions.
 shape=''.join(str(len(node))+':'+node for node in static)
 return hashlib.sha256(shape.encode()).hexdigest(),tracks

def synchronize(old,new,previous,target,k,keepalive):
 static,old_nodes=previous;new_static,new_nodes=target
 if static!=new_static:return new,dict(mode='reload',reason='non_copper_state_changed')
 old_items={t.m_Uuid.AsString():t for t in old.GetTracks()};new_items={t.m_Uuid.AsString():t for t in new.GetTracks()}
 if set(old_items)!=set(old_nodes) or set(new_items)!=set(new_nodes):return new,dict(mode='reload',reason='unsupported_copper_inventory')
 remove=[uid for uid,node in old_nodes.items() if new_nodes.get(uid)!=node]
 add=[uid for uid,node in new_nodes.items() if old_nodes.get(uid)!=node]
 retired=[old_items[uid] for uid in remove]
 for item in retired:old.Remove(item)
 clones=[]
 for uid in add:
  item=new_items[uid];clone=item.Duplicate();clone.SetUuid(item.m_Uuid)
  # Native Add reparents; net codes are valid because static net declarations match.
  old.Add(clone);clone.SetNetCode(item.GetNetCode());clones.append(clone)
 # KiCad/SWIG objects must outlive all boards and native checks referencing them.
 # The session owns this bounded keepalive arena until the whole host exits.
 keepalive.extend([new, old_items, new_items, retired, clones])
 old.SetFileName(new.GetFileName());old.BuildConnectivity()
 return old,dict(mode='delta',removed=len(remove),added=len(add))
