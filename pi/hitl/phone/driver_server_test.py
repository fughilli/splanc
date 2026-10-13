import asyncio
import json
import unittest
from unittest.mock import AsyncMock

import websockets
from driver_server import AppDriver, DriverError
from journey_runner import run_journey


class ConnectFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_connection_to_requested_device_does_not_repair_or_retrust(self):
        driver = AppDriver()
        driver.query = AsyncMock(
            return_value={
                "status": {"state": "connected"},
                "wssUrl": "wss://device/ws",
                "welcome": {"mac": "AA:BB"},
            }
        )
        driver.command = AsyncMock()
        result = await run_journey(
            driver,
            {"name": "connect", "steps": [{"do": "connect"}]},
            {},
            {"device_ws": "wss://device/ws"},
        )
        self.assertEqual(result[0]["step"], "already connected to requested device")
        driver.command.assert_not_awaited()

    async def test_connection_to_another_device_does_not_skip_connect(self):
        driver = AppDriver()
        driver.query = AsyncMock(
            return_value={
                "status": {"state": "connected"},
                "wssUrl": "wss://other/ws",
                "welcome": {"mac": "AA:BB"},
            }
        )
        driver.command = AsyncMock(return_value={"connecting": True})
        journey = {
            "name": "connect",
            "steps": [{"do": "connect", "with": {"wssUrl": "${device_ws}"}}],
        }
        await run_journey(driver, journey, {}, {"device_ws": "wss://device/ws"})
        driver.command.assert_awaited_once_with("connect", timeout=60.0, wssUrl="wss://device/ws")

    async def test_existing_connection_still_requires_hardware_identity(self):
        driver = AppDriver()
        driver.query = AsyncMock(
            return_value={
                "status": {"state": "connected"},
                "wssUrl": "wss://device/ws",
                "welcome": {},
            }
        )
        with self.assertRaises(DriverError):
            await run_journey(driver, {"name": "connect"}, {}, {"device_ws": "wss://device/ws"})


class ReloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_reload_holds_commands_while_old_page_socket_is_still_open(self):
        server = AppDriver.serve(0, host="127.0.0.1")
        async with server as driver:
            port = server._server.sockets[0].getsockname()[1]
            url = f"ws://127.0.0.1:{port}"
            async with websockets.connect(url) as old:
                await old.send(json.dumps({"kind": "event", "event": "ready"}))
                await driver.wait_ready(timeout=1)
                driver.prepare_reload()
                query = asyncio.create_task(driver.query("appState", timeout=2))
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(old.recv(), timeout=0.03)
                async with websockets.connect(url) as fresh:
                    await fresh.send(json.dumps({"kind": "event", "event": "ready"}))
                    command = json.loads(await asyncio.wait_for(fresh.recv(), timeout=1))
                    await fresh.send(
                        json.dumps(
                            {"kind": "result", "id": command["id"], "ok": True, "value": "fresh"}
                        )
                    )
                    self.assertEqual(await query, "fresh")

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
