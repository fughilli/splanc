# chsound: two-C6 channel sounding and ranging (research bench)

Host side of the channel-sounding research track. Findings and measured numbers:
[`docs/research/channel-sounding.md`](../../docs/research/channel-sounding.md). Firmware:
[`firmware/chsound`](../../firmware/chsound) (bench only; never a player image).

| File        | What                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csd.py`    | Rig-side daemon. Runs inside the hitl reservation env, holds both C6 serial ports (found by USB serial through sysfs) and the HackRF, and executes JSON step lists on `127.0.0.1:7700`, so a two-device sequence runs with rig-local timing. Stdlib + pyserial. |
| `cslib.py`  | Client (`Bench`), dump-word decoding, PSD helper.                                                                                                                                                                                                               |
| `cspipe.py` | Signal processing: multitone waveforms, waveform upload, per-tone phasors at the receiver's clock, relative clock error fit, delay estimation (IFFT peak + weighted phase slope), CIR, onset detection.                                                         |
| `twoway.py` | One two-way exchange (`Sounder.exchange()`): the firmware `seq` programs for both DUTs and the combination into the round-trip group delay `2tau` and the two-way carrier phase.                                                                                |

## Running

1. Reserve the SDR bench and keep the lease (the second C6 is not in the catalog yet; the
   privileged `c6-sdr` env sees every `/dev/ttyACM*`, see the research doc §Rig):

   ```sh
   python3 hold_resv.py &        # Reservation(device="c6-sdr"), writes resv.json; touch resv.stop to release
   ```

2. Build and flash `//firmware/chsound:esp32c6_flashbundle` to both DUTs
   (`hitl-flash --port <tty of each C6>`).
3. Copy `csd.py` into the env and start it (`python3 /tmp/csd.py 7700 &`), then forward the
   port: `ssh -N -L 7700:127.0.0.1:7700 -p <unit port> agent@amd-rig`.
4. From here (needs numpy):

   ```python
   from cslib import Bench
   import twoway
   s = twoway.Sounder(Bench(), fc=2440e6)
   s.setup()                       # tune, HT40, forced RX gain, upload the multitone to both
   r = s.exchange()                # {'two_tau': s, 'carrier': rad, 'deltaB': ..., ...}
   ```

`two_tau` contains a fixed hardware offset (both boards' TX and RX chain delays). Subtract a
calibration taken at a known separation: `range = c * (two_tau - two_tau_cal) / 2 + d_cal`.

The experiment scripts that produced the numbers in the research doc are kept with the raw
data under `/workspace/.claude/chsound/exp/` on the agent host (not in the repo).
