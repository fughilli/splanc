// A stand-in for preload.js + the sidecar, so the window can be opened in a plain
// browser and screenshotted in each state (tools/screenshots.sh). Not shipped.
//   index.html#board | #wifi | #card | #write | #done | #error
// Everything is synchronous (events are delivered immediately and the driver
// awaits only microtasks) so a headless screenshot at load sees the final state.
'use strict';
(() => {
  const listeners = [];
  const emit = (evt) => listeners.forEach((cb) => cb(evt));
  const release = {
    tag: 'pi-bridge-v1.0.0',
    version: '1.0.0',
    published_at: '2026-10-21T00:00:00Z',
    boards: [
      { board: 'pi5', board_name: 'Raspberry Pi 5', size: 438e6 },
      { board: 'pi4', board_name: 'Raspberry Pi 4 / 400', size: 434e6 },
      { board: 'pi3', board_name: 'Raspberry Pi 3 (B, B+, A+)', size: 434e6 },
      { board: 'zero2w', board_name: 'Raspberry Pi Zero 2 W', size: 434e6 },
    ],
  };
  const older = {
    ...release,
    tag: 'pi-bridge-v0.9.0',
    version: '0.9.0',
    published_at: '2026-10-02T00:00:00Z',
    boards: release.boards.slice(0, 3),
  };
  const disks = [
    { id: '/dev/rdisk4', name: 'SanDisk Ultra microSD', size: 31914983424, size_gb: 31.9, bus: 'USB', large: false },
    { id: '/dev/rdisk6', name: 'Backup Drive', size: 2000398934016, size_gb: 2000.4, bus: 'USB', large: true },
  ];
  window.flasher = {
    platform: 'darwin',
    onEvent: (cb) => listeners.push(cb),
    confirmErase: async () => true,
    confirmLarge: async () => true,
    pickImage: async () => null,
    openLink: async () => {},
    send: (msg) => {
      if (msg.cmd === 'release') emit({ type: 'release', release, releases: [release, older] });
      if (msg.cmd === 'list_disks') emit({ type: 'disks', disks });
      if (msg.cmd === 'validate') {
        const f = msg.form;
        const name = (f.device_name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        emit({ type: 'validation', errors: {}, hostname: name || 'splanc-bridge' });
      }
    },
  };

  const style = document.createElement('style');
  style.textContent = '.pane { animation: none !important } * { transition: none !important }';
  document.head.append(style);

  document.addEventListener('DOMContentLoaded', async () => {
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    const click = (sel) => document.querySelector(sel).click();
    const want = location.hash.slice(1) || 'board';
    const reach = ['board', 'wifi', 'card', 'write', 'done', 'error'].indexOf(want);
    emit({ type: 'ready', version: '1.0.0' });
    if (reach < 1) return;
    click('#boards .card:nth-child(1)');
    click('#board-next');
    document.getElementById('ssid').value = 'Kitchen WiFi';
    document.getElementById('psk').value = 'correct horse battery';
    const dn = document.getElementById('device-name');
    dn.value = 'Living Room';
    dn.dispatchEvent(new Event('input'));
    if (reach < 2) return;
    click('#wifi-next');
    await flush();
    click('#disks .card:nth-child(1)');
    if (reach < 3) return;
    click('#card-write');
    await flush();
    if (reach === 3) {
      for (const [stage, frac, overall] of [['download', 1, 0.34], ['verify', 1, 0.38], ['unpack', 1, 0.48], ['write', 0.62, 0.7]]) {
        emit({ type: 'progress', stage, frac, overall, message: 'Writing: 1292 of 2085 MB' });
      }
    } else if (reach === 4) {
      emit({ type: 'flash_done', hostname: 'living-room', disk: disks[0], board: 'pi5', version: '1.0.0' });
    } else {
      emit({
        type: 'flash_error',
        message:
          "macOS blocked raw disk access to /dev/rdisk4. Open System Settings > Privacy & Security > Full Disk Access, turn on 'Splanc Bridge Flasher' (add it with + if it isn't listed), quit and reopen the app, and flash again.",
      });
    }
  });
})();
