"""Strict native text report adapter. Ambiguous/missing IDs must fall back to CLI."""
import re
from collections import defaultdict

class UnsupportedReport(ValueError):pass

def item_index(board,k):
 units=k.UNITS_PROVIDER(k.pcbIUScale,k.EDA_UNITS_MM)
 items=list(board.GetTracks())+list(board.GetDrawings())+list(board.Zones())
 for f in board.GetFootprints():
  items.append(f);items.extend(f.Pads());items.extend(f.GraphicalItems());items.extend(f.GetFields())
 index=defaultdict(dict)
 for item in items:
  p=item.GetPosition();desc=item.GetItemDescription(units,True)
  key=(f'{p.x/1e6:.4f}',f'{p.y/1e6:.4f}',desc)
  index[key][item.m_Uuid.AsString()]=dict(uuid=item.m_Uuid.AsString(),description=desc,pos=dict(x=p.x/1e6,y=p.y/1e6),_anchor=(p.x,p.y),_kind=item.GetClass(),_net=item.GetNetCode() if hasattr(item,'GetNetCode') else None,_layer=item.GetLayer())
 return index

def parse(text,index):
 if not text.rstrip().endswith('** End of Report **'):raise UnsupportedReport('Incomplete native report')
 section=None;counts={};result=dict(violations=[],unconnected_items=[],schematic_parity=[]);entry=None
 sections={'DRC violations':'violations','unconnected pads':'unconnected_items','Footprint errors':'schematic_parity'}
 for raw in text.splitlines():
  line=raw.strip()
  if not line:continue
  m=re.fullmatch(r'\*\* Found (\d+) (.+) \*\*',line)
  if m:
   section=sections[m[2]];counts[section]=int(m[1]);entry=None;continue
  if line.startswith('**'):continue
  m=re.fullmatch(r'\[([^]]+)\]: (.*)',line)
  if m:
   if section is None:raise UnsupportedReport('No section')
   entry=dict(type=m[1],description=m[2],items=[]);result[section].append(entry);continue
  if entry is None:raise UnsupportedReport('Unexpected report text')
  m=re.fullmatch(r'(.*); (error|warning|ignore)',line)
  if m:entry['severity']=m[2];continue
  m=re.fullmatch(r'@\((-?\d+\.\d+) mm, (-?\d+\.\d+) mm\): (.+)',line)
  if m:
   matches=index.get((m[1],m[2],m[3]),{})
   if not matches:raise UnsupportedReport('Missing native item: '+line)
   aliases=sorted(matches)
   if len(matches)>1:
    signatures={(tuple(x['_anchor']),x['_kind'],x['_net'],x['_layer']) for x in matches.values()}
    if entry['type']!='unconnected_items' or len(signatures)!=1 or next(iter(signatures))[1]!='PCB_TRACK' or not next(iter(signatures))[2]:
     raise UnsupportedReport('Ambiguous native violation: '+line)
   item={key:value for key,value in matches[aliases[0]].items() if not key.startswith('_')}
   if len(aliases)>1:item['equivalent_track_uuids_at_exact_shared_endpoint']=aliases
   entry['items'].append(item);continue
  raise UnsupportedReport('Unsupported native text: '+line)
 if set(counts)!=set(result) or any(len(result[key])!=counts[key] for key in result):raise UnsupportedReport('Count mismatch')
 if any('severity' not in e for entries in result.values() for e in entries):raise UnsupportedReport('Missing severity')
 return result
