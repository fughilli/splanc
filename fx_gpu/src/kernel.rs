//! Build [`crate::eval::Inputs`] from the same `fx_vm` state a `shade()` call
//! sees, so the evaluator is fed byte-identically to the VM. This is the CPU
//! side of the real pipeline in miniature: per frame fill uniforms/state and
//! the frame context; per LED fill the LED context (the GPU reads these from a
//! UBO/SSBO and a per-LED position buffer).

use crate::eval::Inputs;
use ledmapper_fx_vm as vm;

pub fn inputs(uniforms: &[f32], state: &[f32], frame: &vm::Frame, led: &vm::Led) -> Inputs {
    let mut inp = Inputs {
        uniforms: uniforms.iter().map(|f| f.to_bits()).collect(),
        state: state.iter().map(|f| f.to_bits()).collect(),
        ..Default::default()
    };
    // Float LED context ids the lowering may read.
    put3(&mut inp.led_ctx, vm::C_LED_POS, led.pos);
    put2(&mut inp.led_ctx, vm::C_LED_UV, led.uv);
    put1(&mut inp.led_ctx, vm::C_LED_IDX, led.idx as f32);
    put1(&mut inp.led_ctx, vm::C_LED_COUNT, frame.led_count as f32);
    put1(&mut inp.led_ctx, vm::C_LED_SEG, led.seg as f32);
    put1(&mut inp.led_ctx, vm::C_LED_S, led.s);
    put1(&mut inp.led_ctx, vm::C_LED_BRANCH, if led.branch { 1.0 } else { 0.0 });
    put1(&mut inp.led_ctx, vm::C_LED_DIST, led.dist);
    put3(&mut inp.led_ctx, vm::C_LED_ROOM, if frame.room_posed { led.room } else { led.pos });
    // Frame float context.
    put1(&mut inp.led_ctx, vm::C_TIME, frame.time);
    put1(&mut inp.led_ctx, vm::C_DT, frame.dt);
    put1(&mut inp.led_ctx, vm::C_FRAME, frame.frame as f32);
    put3(&mut inp.led_ctx, vm::C_IMU_ACCEL, frame.imu_accel);
    put3(&mut inp.led_ctx, vm::C_IMU_GYRO, frame.imu_gyro);
    put3(&mut inp.led_ctx, vm::C_ROOM_MIN, frame.room_min);
    put3(&mut inp.led_ctx, vm::C_ROOM_MAX, frame.room_max);

    // Q16.16 fixed mirrors (raw int words) for LoadCtxFix.
    put3i(&mut inp.led_ctx_fix, vm::C_LED_POS, led.pos_fix);
    put2i(&mut inp.led_ctx_fix, vm::C_LED_UV, led.uv_fix);
    put1i(&mut inp.led_ctx_fix, vm::C_LED_S, led.s_fix);
    put1i(&mut inp.led_ctx_fix, vm::C_LED_DIST, led.dist_fix);
    put1i(&mut inp.led_ctx_fix, vm::C_LED_IDX, led.idx as i32);
    put1i(&mut inp.led_ctx_fix, vm::C_LED_SEG, led.seg);
    put1i(&mut inp.led_ctx_fix, vm::C_LED_COUNT, frame.led_count as i32);
    put3i(&mut inp.led_ctx_fix, vm::C_LED_ROOM, if frame.room_posed { led.room_fix } else { led.pos_fix });
    put1i(&mut inp.frame_ctx_fix, vm::C_TIME, frame.time_fix);
    put1i(&mut inp.frame_ctx_fix, vm::C_DT, frame.dt_fix);
    put1i(&mut inp.frame_ctx_fix, vm::C_FRAME, frame.frame as i32);
    put3i(&mut inp.frame_ctx_fix, vm::C_IMU_ACCEL, frame.imu_accel_fix);
    put3i(&mut inp.frame_ctx_fix, vm::C_IMU_GYRO, frame.imu_gyro_fix);
    put3i(&mut inp.frame_ctx_fix, vm::C_ROOM_MIN, frame.room_min_fix);
    put3i(&mut inp.frame_ctx_fix, vm::C_ROOM_MAX, frame.room_max_fix);
    inp
}

type Map = std::collections::HashMap<(u8, u8), u32>;
fn put1(m: &mut Map, id: u8, v: f32) {
    m.insert((id, 0), v.to_bits());
}
fn put2(m: &mut Map, id: u8, v: [f32; 2]) {
    for (c, x) in v.iter().enumerate() {
        m.insert((id, c as u8), x.to_bits());
    }
}
fn put3(m: &mut Map, id: u8, v: [f32; 3]) {
    for (c, x) in v.iter().enumerate() {
        m.insert((id, c as u8), x.to_bits());
    }
}
fn put1i(m: &mut Map, id: u8, v: i32) {
    m.insert((id, 0), v as u32);
}
fn put2i(m: &mut Map, id: u8, v: [i32; 2]) {
    for (c, x) in v.iter().enumerate() {
        m.insert((id, c as u8), *x as u32);
    }
}
fn put3i(m: &mut Map, id: u8, v: [i32; 3]) {
    for (c, x) in v.iter().enumerate() {
        m.insert((id, c as u8), *x as u32);
    }
}
