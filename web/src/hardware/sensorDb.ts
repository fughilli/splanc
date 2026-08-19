/**
 * Known-sensor database for auto hardware discovery (FUG-107).
 *
 * A qwiic/I2C bus scan (client.scanI2c) returns the 7-bit addresses that ACK.
 * An address alone is ambiguous — 0x48 is an ADS1115, a TMP102, AND an LM75 —
 * so this table maps each address to the modules that live there. The UI shows
 * the candidates and lets the user pick; the AI then fetches the datasheet and
 * writes a driver. When nothing matches, the user names the part directly.
 *
 * This is intentionally a curated subset of the common qwiic ecosystem, not an
 * exhaustive registry. `datasheet` is filled only where the canonical URL is
 * known; otherwise the AI/user searches by `part`. Addresses include the
 * strap-selectable alternates a board may expose.
 */

/** One known I2C module. */
export interface KnownSensor {
  /** Canonical part number, e.g. "BME280". Also the AI's datasheet search key. */
  part: string;
  /** Short human label / what it is. */
  label: string;
  /** 7-bit I2C addresses this device can appear at (default first). */
  addresses: number[];
  /** What the driver should expose as exports (hint for the UI + AI). */
  measures: string[];
  /** Canonical datasheet URL, when known (the AI fetches + reads it). */
  datasheet?: string;
}

/**
 * The table. Kept flat (one entry per part) and indexed by address lazily —
 * a part commonly answers at more than one address, and several parts share
 * one address, so neither direction is a clean unique key.
 */
export const KNOWN_SENSORS: KnownSensor[] = [
  {
    part: "BME280",
    label: "Temp / humidity / pressure",
    addresses: [0x77, 0x76],
    measures: ["temperature", "humidity", "pressure"],
    datasheet:
      "https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf",
  },
  {
    part: "BMP280",
    label: "Temp / pressure",
    addresses: [0x77, 0x76],
    measures: ["temperature", "pressure"],
  },
  {
    part: "SHT31",
    label: "Temp / humidity",
    addresses: [0x44, 0x45],
    measures: ["temperature", "humidity"],
  },
  {
    part: "TMP102",
    label: "Temperature",
    addresses: [0x48, 0x49, 0x4a, 0x4b],
    measures: ["temperature"],
  },
  {
    part: "ADS1115",
    label: "4-ch 16-bit ADC",
    addresses: [0x48, 0x49, 0x4a, 0x4b],
    measures: ["voltage"],
  },
  {
    part: "MPU6050",
    label: "6-axis IMU (accel + gyro)",
    addresses: [0x68, 0x69],
    measures: ["accel", "gyro", "temperature"],
  },
  {
    part: "MPU9250",
    label: "9-axis IMU",
    addresses: [0x68, 0x69],
    measures: ["accel", "gyro", "mag"],
  },
  {
    part: "LSM6DS3",
    label: "6-axis IMU (accel + gyro)",
    addresses: [0x6a, 0x6b],
    measures: ["accel", "gyro"],
  },
  {
    part: "LIS3DH",
    label: "3-axis accelerometer",
    addresses: [0x18, 0x19],
    measures: ["accel"],
  },
  {
    part: "ADXL345",
    label: "3-axis accelerometer",
    addresses: [0x53, 0x1d],
    measures: ["accel"],
  },
  {
    part: "VL53L1X",
    label: "Time-of-flight distance",
    addresses: [0x29],
    measures: ["distance"],
  },
  {
    part: "VCNL4040",
    label: "Proximity + ambient light",
    addresses: [0x60],
    measures: ["proximity", "lux"],
  },
  {
    part: "VEML7700",
    label: "Ambient light",
    addresses: [0x10],
    measures: ["lux"],
  },
  {
    part: "APDS-9960",
    label: "Gesture / proximity / color",
    addresses: [0x39],
    measures: ["gesture", "proximity", "rgb"],
  },
  {
    part: "TSL2591",
    label: "High-dynamic-range light",
    addresses: [0x29],
    measures: ["lux"],
  },
  {
    part: "CCS811",
    label: "eCO2 / VOC air quality",
    addresses: [0x5a, 0x5b],
    measures: ["eco2", "tvoc"],
  },
  {
    part: "SCD30",
    label: "CO2 / temp / humidity",
    addresses: [0x61],
    measures: ["co2", "temperature", "humidity"],
  },
  {
    part: "SGP30",
    label: "eCO2 / TVOC gas",
    addresses: [0x58],
    measures: ["eco2", "tvoc"],
  },
  {
    part: "MAX30101",
    label: "Heart-rate / pulse-ox",
    addresses: [0x57],
    measures: ["ir", "red"],
  },
  {
    part: "MAX17048",
    label: "LiPo fuel gauge",
    addresses: [0x36],
    measures: ["voltage", "soc"],
  },
  {
    part: "INA219",
    label: "Current / power monitor",
    addresses: [0x40, 0x41, 0x44, 0x45],
    measures: ["voltage", "current", "power"],
  },
  {
    part: "MPL3115A2",
    label: "Pressure / altitude / temp",
    addresses: [0x60],
    measures: ["pressure", "altitude", "temperature"],
  },
  {
    part: "HMC5883L",
    label: "3-axis magnetometer",
    addresses: [0x1e],
    measures: ["mag"],
  },
  {
    part: "BNO085",
    label: "9-axis fusion IMU",
    addresses: [0x4a, 0x4b],
    measures: ["orientation", "accel", "gyro"],
  },
  {
    part: "MPR121",
    label: "12-channel capacitive touch",
    addresses: [0x5a, 0x5b, 0x5c, 0x5d],
    measures: ["touch"],
  },
  {
    part: "AS7341",
    label: "11-channel spectral color",
    addresses: [0x39],
    measures: ["spectrum"],
  },
];

/** Candidate matches for one scanned address. */
export interface AddressMatch {
  /** The scanned 7-bit address. */
  address: number;
  /** Known modules that answer at this address (may be empty = unknown). */
  candidates: KnownSensor[];
}

/** Every known module that can answer at `address` (ascending by part name). */
export function sensorsAtAddress(address: number): KnownSensor[] {
  return KNOWN_SENSORS.filter((s) => s.addresses.includes(address)).sort((a, b) =>
    a.part.localeCompare(b.part),
  );
}

/**
 * Turn a raw scan (7-bit addresses) into per-address candidate lists. Addresses
 * are de-duplicated and returned ascending. An address with no known part gets
 * an empty `candidates` — the caller prompts the user to identify it.
 */
export function identifyScan(addresses: number[]): AddressMatch[] {
  const seen = new Set<number>();
  const out: AddressMatch[] = [];
  for (const address of [...addresses].sort((a, b) => a - b)) {
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({ address, candidates: sensorsAtAddress(address) });
  }
  return out;
}

/** Format a 7-bit address as `0x4A` (uppercase, two digits). */
export function formatAddress(address: number): string {
  return "0x" + address.toString(16).toUpperCase().padStart(2, "0");
}

/** Find a known sensor by exact part name (case-insensitive); undefined if none. */
export function sensorByPart(part: string): KnownSensor | undefined {
  const key = part.trim().toLowerCase();
  return KNOWN_SENSORS.find((s) => s.part.toLowerCase() === key);
}
