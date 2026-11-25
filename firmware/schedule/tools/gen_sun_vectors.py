#!/usr/bin/env python3
"""Sunrise/sunset reference vectors for //firmware/schedule:sun_test.

An independent float64 implementation of the same NOAA equations (Spencer's
series, -0.833 deg horizon, a second pass at the first estimate's hour) with
Python's libm, so the test checks the crate's port and its hand-written trig.
Output lines: lat_e4 lon_e4 year month day sunrise_s sunset_s ('-' = none),
seconds relative to 00:00 UTC of the date.

    python3 firmware/schedule/tools/gen_sun_vectors.py > firmware/schedule/tests/testdata/sun_vectors.txt
"""

import datetime
import math

PLACES = [
    (515000, -1000),  # London
    (407000, -740000),  # New York
    (-338700, 1512000),  # Sydney
    (13700, 1038000),  # Singapore (equator-ish)
    (642000, -1500000),  # Fairbanks
    (697000, 189000),  # Tromso (polar night / midnight sun)
    (-545000, -683000),  # Ushuaia
    (198000, -1558000),  # Hawaii
    (356000, 1397000),  # Tokyo
    (0, 1795000),  # near the date line
]
DATES = [(2026, m, d) for m in range(1, 13) for d in (1, 21)] + [(2028, 2, 29)]


def event_min(doy, leap, lat_e4, lon_e4, rise, hour):
    days = 366.0 if leap else 365.0
    g = 2.0 * math.pi / days * (doy - 1.0 + (hour - 12.0) / 24.0)
    eqt = 229.18 * (
        0.000075
        + 0.001868 * math.cos(g)
        - 0.032077 * math.sin(g)
        - 0.014615 * math.cos(2 * g)
        - 0.040849 * math.sin(2 * g)
    )
    decl = (
        0.006918
        - 0.399912 * math.cos(g)
        + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g)
        + 0.000907 * math.sin(2 * g)
        - 0.002697 * math.cos(3 * g)
        + 0.00148 * math.sin(3 * g)
    )
    lat = math.radians(lat_e4 * 1e-4)
    lon = lon_e4 * 1e-4
    c = math.cos(math.radians(90.833)) / (math.cos(lat) * math.cos(decl)) - math.tan(
        lat
    ) * math.tan(decl)
    if not -1.0 <= c <= 1.0:
        return None
    ha = math.degrees(math.acos(c))
    return 720.0 - 4.0 * (lon + ha) - eqt if rise else 720.0 - 4.0 * (lon - ha) - eqt


def event_s(y, m, d, lat_e4, lon_e4, rise):
    date = datetime.date(y, m, d)
    doy = date.timetuple().tm_yday
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    first = event_min(doy, leap, lat_e4, lon_e4, rise, 12.0)
    if first is None:
        return None
    second = event_min(doy, leap, lat_e4, lon_e4, rise, min(max(first / 60.0, -12.0), 36.0))
    v = second if second is not None else first
    return int(math.floor(v * 60.0 + 0.5)) if v >= 0 else -int(math.floor(-v * 60.0 + 0.5))


def main():
    print("# lat_e4 lon_e4 year month day sunrise_s sunset_s (s from 00:00 UTC; - = none)")
    for lat, lon in PLACES:
        for y, m, d in DATES:
            r = event_s(y, m, d, lat, lon, True)
            s = event_s(y, m, d, lat, lon, False)
            print(lat, lon, y, m, d, "-" if r is None else r, "-" if s is None else s)


if __name__ == "__main__":
    main()
