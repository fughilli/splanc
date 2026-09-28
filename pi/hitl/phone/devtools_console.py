import asyncio
import json
import sys
import urllib.request

import websockets


def pages(port):
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5))


async def grab(port, seconds=9):
    ps = [p for p in pages(port) if p.get("type") == "page" and p.get("webSocketDebuggerUrl")]
    ps.sort(key=lambda t: "driver=" not in t.get("url", ""))
    if not ps:
        print("no page tabs; all:", [p.get("url", "")[:70] for p in pages(port)])
        return
    p = ps[0]
    print("PAGE_URL:", p.get("url", "")[:110])
    async with websockets.connect(p["webSocketDebuggerUrl"], max_size=None) as ws:
        for m in ({"id": 1, "method": "Runtime.enable"}, {"id": 2, "method": "Log.enable"}):
            await ws.send(json.dumps(m))
        loop = asyncio.get_event_loop()
        end = loop.time() + seconds
        while loop.time() < end:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - loop.time()))
            except asyncio.TimeoutError:
                break
            e = json.loads(raw)
            meth = e.get("method", "")
            if meth == "Runtime.consoleAPICalled":
                a = e["params"]
                print(
                    "CONSOLE",
                    a.get("type"),
                    " ".join(
                        str(x.get("value", x.get("description", "")))[:200]
                        for x in a.get("args", [])
                    ),
                )
            elif meth == "Runtime.exceptionThrown":
                d = e["params"]["exceptionDetails"]
                print(
                    "EXCEPTION",
                    d.get("text"),
                    (d.get("exception") or {}).get("description", "")[:300],
                )
            elif meth == "Log.entryAdded":
                entry = e["params"]["entry"]
                print("LOG", entry.get("level"), entry.get("text", "")[:200])


if __name__ == "__main__":
    asyncio.run(grab(int(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 9))
