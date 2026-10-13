import asyncio
import json
import unittest

import websockets
from driver_server import AppDriver


class ReloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_command_waits_for_reloaded_app_to_be_ready(self):
        server = AppDriver.serve(0, host="127.0.0.1")
        async with server as driver:
            port = server._server.sockets[0].getsockname()[1]
            url = f"ws://127.0.0.1:{port}"
            async with websockets.connect(url) as first:
                await first.send(json.dumps({"kind": "event", "event": "ready"}))
                await driver.wait_ready(timeout=1)
            for _ in range(100):
                if not driver._ready.is_set():
                    break
                await asyncio.sleep(0.01)
            self.assertFalse(driver._ready.is_set())
            query = asyncio.create_task(driver.query("appState", timeout=2))
            async with websockets.connect(url) as refreshed:
                await asyncio.sleep(0.02)
                self.assertFalse(query.done())
                await refreshed.send(json.dumps({"kind": "event", "event": "ready"}))
                command = json.loads(await asyncio.wait_for(refreshed.recv(), timeout=1))
                self.assertEqual(command["method"], "appState")
                await refreshed.send(
                    json.dumps(
                        {
                            "kind": "result",
                            "id": command["id"],
                            "ok": True,
                            "value": {"fresh": True},
                        }
                    )
                )
                self.assertEqual(await query, {"fresh": True})


if __name__ == "__main__":
    unittest.main()
