#!/usr/bin/env python3
"""Planning gross-margin calculation. Never changes prices in an external store."""
import json
from pathlib import Path
P=Path(__file__).resolve().parent
x=json.loads((P/'assumptions.json').read_text());out={'date':x['date'],'currency':'USD','volume_per_product':x['volume_per_product'],'products':{}}
for name,v in x['products'].items():
 costs=[sum(line['low_mid_high'][i] for line in v['cost_lines']) for i in range(3)]
 price=v['launch_price']
 out['products'][name]={'cost_low_mid_high':[round(z,2) for z in costs],'launch_price':price,'target_margin':v['target_margin'],'target_price_at_mid_cost':round(costs[1]/(1-v['target_margin']),2),'margin_low_mid_high_cost':[round(1-z/price,4) for z in costs],'gross_profit_at_mid_cost':round(price-costs[1],2),'margin_after_tool_amortized':round(1-(costs[1]-v['tooling_per_unit'])/price,4),'contribution_after_example_8percent_platform_payment_fee':round(1-costs[1]/price-.08,4),'scope':v['scope']}
(P/'launch-prices.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
