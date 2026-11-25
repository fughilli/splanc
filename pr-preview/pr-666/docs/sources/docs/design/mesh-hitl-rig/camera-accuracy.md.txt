| Condition | 1 s window: bias / sd / p95 abs (us) | 10 s capture p95 abs (us) | one flip in an exposure, p95 abs (us) | flips in a gap | untrusted windows |
|---|---|---|---|---|---|
| global shutter 120 fps, E 95 % | -0.2 / 3.8 / 7.3 | 2.8 | 29 | 10 % | 0 % |
| + 1 ms render jitter (FreeRTOS tick) | -6.0 / 89 / 181 | 100 | - | - | 0 % |
| + 1 kHz PWM restart on turn-on | -6.0 / 85 / 174 | 125 | - | - | 0 % |
| +/-30 ppm DUT clocks | 1.6 / 4.0 / 8.7 | 4.7 | 29 | 9 % | 0 % |
| 300 us camera start jitter | 0.0 / 3.6 / 7.1 | 2.3 | 28 | 9 % | 0 % |
| exposure 50 % | 0.1 / 2.5 / 4.8 | 16 | 15 | 52 % | 8 % |
| global shutter 90 fps | -0.1 / 4.9 / 9.8 | 2.5 | 40 | 9 % | 0 % |
| 60 fps, measured levels | 0.4 / 7.7 / 16 | 4.6 | 44 | 17 % | 0 % |
| rolling 120 fps, rows 100/900, line time known | -0.3 / 3.9 / 7.8 | 3.1 | 29 | 8 % | 0 % |
| rolling, line time 2 % off | 128 / 3.9 / 134 | 130 | 40 | 8 % | 0 % |
| gamma 2.2 not linearised | 0.6 / 57 / 97 | 99 | 1315 | 8 % | 0 % |
| gamma 2.2 + response LUT | -1.0 / 13 / 15 | 4.2 | 32 | 5 % | 0 % |
| full frames + MJPEG q85 + ROI detect | -2.7 / 11 / 22 | 16 | - | - | 0 % |
