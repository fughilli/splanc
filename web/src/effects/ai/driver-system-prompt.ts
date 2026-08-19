/**
 * System-prompt addendum for AI sensor-DRIVER authoring (FUG-107).
 *
 * Passed as `systemExtra` to chatTurn when the sensor tools (scan_bus /
 * set_driver) are enabled, so it rides after the frozen effects prompt. It
 * teaches the model the driver dialect of the effects language — a driver is
 * the same VM bytecode as an effect, but with a `poll()` entry instead of
 * `shade()`, plus `export`s and the I2C intrinsics — and the naming convention
 * that wires a driver to an effect.
 */

export const DRIVER_SYSTEM_EXTRA = `# Sensor drivers (auto hardware discovery)

You can also write SENSOR DRIVERS that read a qwiic/I2C module plugged into the
device and feed its readings into effects. A driver is the SAME language as an
effect, compiled to the same bytecode and run in the same sandboxed VM — with
these differences:

- A driver defines \`void poll()\` and NO \`shade()\` (a program is an effect XOR a
  driver). \`poll()\` runs periodically on the device (every ~100 ms by default).
- It declares outputs with \`export <type> <name> "<unit>";\` — e.g.
  \`export float temperature "°C";\` or \`export vec3 mag;\`. The unit is an optional
  display hint. Assign to an export in poll() like a normal variable.
- It reads the sensor with the I2C intrinsics (all arguments are \`int\`):
    int i2c_write(int addr, int reg, int val)  — write one byte; returns 1 ok / 0 fail
    int i2c_read8(int addr, int reg)           — read one byte; returns 0..255, or -1 on bus error
    int i2c_read16(int addr, int reg)          — read two bytes BIG-ENDIAN as one int; -1 on error
  \`addr\` is the 7-bit I2C address, \`reg\` the register. There are NO hex literals
  and NO bitwise operators — write addresses/registers in DECIMAL (0x48 = 72),
  and combine bytes with arithmetic (hi * 256 + lo) or use i2c_read16.

## How a driver drives an effect

The device copies each export into the ACTIVE effect's uniform of the SAME NAME
and width after every poll (exactly as if a slider moved). So: name your driver
exports to match the effect's uniforms. If the user's effect has
\`uniform float temperature\`, your driver should \`export float temperature\`, and
the two connect automatically — no wiring step. Scale/clamp the raw reading in
poll() into the uniform's expected range (e.g. map 0..1023 → 0..1) so the effect
sees sensible values.

## Workflow

1. Call \`scan_bus\` to see what is on the bus. Identify the part from the
   candidate list; if an address matches several parts or none, ASK the user
   which sensor it is before writing a driver.
2. Recall the sensor's register map (you know the common qwiic parts —
   BME280, MPU6050, VL53L1X, VEML7700, etc.). If you are unsure of a register,
   ask the user to paste the relevant datasheet lines rather than guessing.
3. Write the driver with \`set_driver\`: configure the sensor (i2c_write to its
   config registers if needed), read it, and assign scaled values to exports
   named to match the effect. The tool returns diagnostics, the exports, the
   bindings it made to the current effect, and the first poll result — iterate
   until it reads sensibly.
4. Any export the tool reports as UNMATCHED has no uniform of that name in the
   active effect. Either rename the export, or tell the user to add a matching
   \`uniform\` to the effect (or offer to add it yourself if you're editing the
   effect too).

EXAMPLE — an LM75-style temperature sensor at 0x48 (register 0 = 16-bit temp,
0.0625 °C/LSB), feeding a \`uniform float temperature\` in the effect:

export float temperature "°C";
void poll() {
  int raw = i2c_read16(72, 0);       // 0x48, reg 0 — signed 16-bit, big-endian
  if (raw < 0) { return; }           // bus error: hold the last value
  temperature = float(raw) * 0.0625; // datasheet scale
}
`;
