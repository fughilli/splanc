// MPU-6050 as a driver-VM program (FUG-107): the A/B twin of the native
// driver in //firmware/sensor. poll() runs on the player's loop task at the
// submit's poll interval; it reads the raw accel + gyro registers and exports
// them as counts. The firmware feeds imu_raw_* into the SAME native fusion as
// the native driver (scaling, calibration, Mahony, gestures, uniform pool), so
// only the bus/driver layer differs between the two backends.
//
// Configuration matches the native driver: PLL clock, DLPF 42 Hz, 100 Hz,
// ±1000 °/s, ±8 g (so the native scale factors apply unchanged).
export vec3 imu_raw_accel;   // counts, ±8 g range (4096 LSB/g)
export vec3 imu_raw_gyro;    // counts, ±1000 °/s range (32.8 LSB/°/s)
export float imu_ok;         // 1 once configured and reading

state float configured;

void poll() {
  int a = 104;                         // 0x68 (AD0 low)
  if (configured < 0.5) {
    int who = i2c_read8(a, 117);       // WHO_AM_I
    if (who != 104 && who != 112 && who != 113 && who != 115 && who != 152) {
      imu_ok = 0.0;
      return;
    }
    int acks = i2c_write(a, 107, 1);   // PWR_MGMT_1: wake, PLL on X gyro
    acks = acks + i2c_write(a, 25, 9); // SMPLRT_DIV: 1 kHz / 10 = 100 Hz
    acks = acks + i2c_write(a, 26, 3); // CONFIG: DLPF ~42 Hz
    acks = acks + i2c_write(a, 27, 16); // GYRO_CONFIG: ±1000 °/s
    acks = acks + i2c_write(a, 28, 16); // ACCEL_CONFIG: ±8 g
    if (acks == 5) {
      configured = 1.0;
    }
  }
  int ax = i2c_read16s(a, 59);         // ACCEL_XOUT_H (signed big-endian)
  int ay = i2c_read16s(a, 61);
  int az = i2c_read16s(a, 63);
  int gx = i2c_read16s(a, 67);         // GYRO_XOUT_H
  int gy = i2c_read16s(a, 69);
  int gz = i2c_read16s(a, 71);
  imu_raw_accel = vec3(float(ax), float(ay), float(az));
  imu_raw_gyro = vec3(float(gx), float(gy), float(gz));
  imu_ok = 1.0;
}
