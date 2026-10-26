// Back-to-back frames at a 120 fps cadence (one frame start every 8.333 ms) on
// 20 ports, SCK asynchronous to the 54 MHz core, STATS on. Per port, frames are
// split by a LOW >= 50 us (the WS latch) and each frame is checked byte-for-byte.
//
//   A: led_type 0 (80 us latch), 270 LEDs/port x 4 frames -- the 120 fps budget
//      at classic WS2812B timing (270 x 29.9 us + 80 us = 8.15 ms < 8.33 ms).
//   A also starts its last frame 120 us early, inside the previous frame's 80 us
//      latch window: those bytes must wait in the FIFO, not be dropped.
//   B: led_type 1 (300 us latch, WS2812B-V5 / SK6812 class), 266 LEDs x 3 frames
//      (266 x 29.9 us + ~40 us prefill latency + 300 us = 8.29 ms; 267 is the
//      120 fps limit at a 300 us latch).
//   C: a 1-LED frame (3 bytes/port < PREFILL = 4): must still be emitted
//      ("start when CS ends with data").
//   E: frame-done pacing at the 260-LED cap: each STREAM starts only after the
//      core's frame_done rises, plus a modelled 100 us host wake-up latency
//      (Linux GPIO edge -> output thread). 4 frames at led_type 0 (80 us latch)
//      and 4 at led_type 1 (300 us). Every frame must be clean, frame_done must
//      rise exactly once per frame, and the achieved period must stay within the
//      120 fps period (8.333 ms) at both latches.
//   D: frames started 1.3 ms too early (7.0 ms cadence at 270 LEDs): the next
//      frame's bytes join a frame that is still emitting, so the latch between
//      them is lost. That is the failure mode the host must avoid by pacing CS to
//      wire time + latch. The test asserts the merge happens.
// Also checks STATS: no underruns, and max_byte_gap is about one byte at SCK.
// frame_done invariants, every cycle of every phase: never HIGH while any port
// drives HIGH, and every rising edge comes >= one latch after the last WS falling
// edge on any port (and within latch + one bit period + a few clocks of it).
`timescale 1ns / 1ps

module spi_ws281x_120fps_tb;
  localparam integer MAX_PORTS = 20;
  localparam integer CLK_MHZ = 54;
  localparam integer T0H_NS = 350, T1H_NS = 700, PERIOD_NS = 1250;
  localparam integer PREFILL = 4;
  localparam real SCK_MHZ = 18.0;
  localparam real CLK_HALF = 500.0 / CLK_MHZ;
  localparam real SCK_HALF = 500.0 / SCK_MHZ;
  localparam real FRAME_NS = 1.0e9 / 120.0;  // 8.333 ms
  localparam integer T0H_CLK = T0H_NS * CLK_MHZ / 1000;
  localparam integer T1H_CLK = T1H_NS * CLK_MHZ / 1000;
  localparam integer MID = (T0H_CLK + T1H_CLK) / 2;
  localparam integer LATCH_CLK = 50 * CLK_MHZ;
  localparam integer MAXF = 24;
  localparam integer DFIRST = 16;  // phase D frames index from here (merges expected)
  localparam real WAKE_NS = 100000.0;  // modelled host wake-up after frame_done rises
  localparam integer CAP_LEDS = 260;   // the 120 fps strip-length cap
  localparam [7:0] OP_WRITE_CSR = 8'h01, OP_STREAM = 8'h02;

  reg clk = 0;
  always #(CLK_HALF) clk = ~clk;
  reg rst = 1, ss = 1, sck = 0, mosi = 0;
  wire [MAX_PORTS-1:0] ws;
  wire frame_pulse, frame_done, st_underrun;
  wire [15:0] st_underruns, st_min_fill, st_max_byte_gap;
  wire [8*MAX_PORTS-1:0] st_port_underruns;

  spi_ws281x #(
      .MAX_PORTS(MAX_PORTS),
      .CLK_MHZ(CLK_MHZ),
      .T0H_NS(T0H_NS),
      .T1H_NS(T1H_NS),
      .PERIOD_NS(PERIOD_NS),
      .RESET_NS(80000),
      .RESET_ALT_NS(300000),
      .MAX_LEDS(1024),
      .FIFO_DEPTH(2048),
      .PREFILL(PREFILL),
      .STATS(1)
  ) dut (
      .clk(clk),
      .rst(rst),
      .ss(ss),
      .sck(sck),
      .mosi(mosi),
      .ws(ws),
      .frame_pulse(frame_pulse),
      .frame_done(frame_done),
      .underrun(st_underrun),
      .underruns(st_underruns),
      .min_fill(st_min_fill),
      .port_underruns(st_port_underruns),
      .max_byte_gap(st_max_byte_gap)
  );

  function automatic [7:0] pat(input integer f, input integer p, input integer k);
    pat = 8'((f * 151 + p * 73 + k * 29 + (k >> 5) * 7 + 32'h3C) ^ (k >> 3));
  endfunction

  // expected frames, in order: bytes/port and pattern seed
  integer exp_k[0:MAXF-1];
  integer nexp = 0;

  // ---- per-port decoder: frames split by a LOW >= 50 us ----
  integer cyc = 0;
  always @(posedge clk) cyc <= cyc + 1;
  integer fidx[0:MAX_PORTS-1], bidx[0:MAX_PORTS-1], bitc[0:MAX_PORTS-1];
  integer hi_start[0:MAX_PORTS-1], last_fall[0:MAX_PORTS-1];
  reg [7:0] acc[0:MAX_PORTS-1];
  reg was_high[0:MAX_PORTS-1], in_frame[0:MAX_PORTS-1];
  integer data_err = 0, count_err = 0, frames_ok = 0, merged = 0;
  integer di, hl;
  reg [7:0] bv;
  task automatic close_frame(input integer p);
    begin
      if (fidx[p] < nexp) begin
        if (bidx[p] != exp_k[fidx[p]]) begin
          if (fidx[p] >= DFIRST) merged = merged + 1;  // phase D frames
          else begin
            count_err = count_err + 1;
            if (count_err < 6)
              $display("port %0d frame %0d: %0d bytes, expected %0d", p, fidx[p], bidx[p], exp_k[fidx[p]]);
          end
        end else if (p == 0) frames_ok = frames_ok + 1;
      end
      fidx[p] = fidx[p] + 1;
      bidx[p] = 0;
      bitc[p] = 0;
      in_frame[p] = 0;
    end
  endtask
  always @(posedge clk) begin
    for (di = 0; di < MAX_PORTS; di = di + 1) begin
      if (ws[di] && !was_high[di]) begin
        hi_start[di] = cyc;
        in_frame[di] = 1;
      end
      if (!ws[di] && was_high[di]) begin
        hl = cyc - hi_start[di];
        bv = {acc[di][6:0], hl > MID};
        acc[di] <= bv;
        last_fall[di] = cyc;
        if (bitc[di] == 7) begin
          if (fidx[di] < nexp && fidx[di] < DFIRST && bidx[di] < exp_k[fidx[di]] &&
              bv !== pat(fidx[di], di, bidx[di])) begin
            data_err = data_err + 1;
            if (data_err < 6)
              $display("port %0d frame %0d byte %0d: got %02x want %02x", di, fidx[di], bidx[di], bv,
                       pat(fidx[di], di, bidx[di]));
          end
          bidx[di] = bidx[di] + 1;
          bitc[di] = 0;
        end else bitc[di] = bitc[di] + 1;
      end
      if (!ws[di] && in_frame[di] && (cyc - last_fall[di]) == LATCH_CLK) close_frame(di);
      was_high[di] <= ws[di];
    end
  end

  // ---- frame_done monitor ----
  integer reset_clk = 80000 * CLK_MHZ / 1000;  // current latch, tracks led_type
  integer last_any_fall = -1000000, fd_rises = 0, fd_err = 0, mi, since;
  reg fd_q = 1'b0;
  always @(posedge clk) begin
    for (mi = 0; mi < MAX_PORTS; mi = mi + 1)
      if (!ws[mi] && was_high[mi]) last_any_fall = cyc;
    if (!rst && frame_done && (|ws)) begin
      fd_err = fd_err + 1;
      if (fd_err < 6) $display("frame_done HIGH while a port drives HIGH at cyc %0d", cyc);
    end
    if (!rst && frame_done && !fd_q) begin
      fd_rises = fd_rises + 1;
      since = cyc - last_any_fall;
      if (since < reset_clk || (last_any_fall > 0 && since < 1000000 &&
                                since > reset_clk + PERIOD_NS * CLK_MHZ / 1000 + 8)) begin
        fd_err = fd_err + 1;
        if (fd_err < 6)
          $display("frame_done rose %0d clk after the last WS fall (latch %0d clk)", since, reset_clk);
      end
    end
    fd_q = frame_done;
  end

  task automatic spi_byte(input [7:0] b);
    integer k;
    begin
      for (k = 7; k >= 0; k = k - 1) begin
        mosi = b[k];
        #(SCK_HALF);
        sck = 1'b1;
        #(SCK_HALF);
        sck = 1'b0;
      end
    end
  endtask
  task automatic csr(input [7:0] a, input [7:0] v);
    begin
      ss = 0;
      #(SCK_HALF * 2);
      spi_byte(OP_WRITE_CSR);
      spi_byte(a);
      spi_byte(v);
      #(SCK_HALF * 2);
      ss = 1;
      #(500.0);
    end
  endtask
  // One frame: k bytes/port of pattern f, CS asserted at absolute time t_start.
  task automatic frame(input integer f, input integer k, input real t_start);
    integer i, p;
    begin
      if ($realtime < t_start) #(t_start - $realtime);
      exp_k[nexp] = k;
      nexp = nexp + 1;
      ss = 0;
      #(SCK_HALF * 2);
      spi_byte(OP_STREAM);
      for (i = 0; i < k; i = i + 1)
      for (p = 0; p < MAX_PORTS; p = p + 1) spi_byte(pat(f, p, i));
      #(SCK_HALF * 2);
      ss = 1;
    end
  endtask

  integer p, f, errors = 0, rises0;
  real t0, tprev, per, per_max0, per_max1;
  initial begin
    for (p = 0; p < MAX_PORTS; p = p + 1) begin
      fidx[p] = 0; bidx[p] = 0; bitc[p] = 0; acc[p] = 0;
      was_high[p] = 0; in_frame[p] = 0; hi_start[p] = 0; last_fall[p] = 0;
    end
    #(CLK_HALF * 20);
    rst = 0;
    #(CLK_HALF * 20);
    csr(8'h00, 8'd20);
    // A: led_type 0, 270 LEDs, 4 frames at 120 fps
    csr(8'h01, 8'd0);
    t0 = $realtime + 1000.0;
    for (f = 0; f < 4; f = f + 1) frame(f, 270 * 3, t0 + f * FRAME_NS - ((f == 3) ? 120000.0 : 0.0));
    // B: led_type 1 (300 us latch), 266 LEDs, 3 frames at 120 fps
    #(FRAME_NS);
    csr(8'h01, 8'd1);
    reset_clk = 300000 * CLK_MHZ / 1000;
    t0 = $realtime + 1000.0;
    for (f = 4; f < 7; f = f + 1) frame(f, 266 * 3, t0 + (f - 4) * FRAME_NS);
    // C: 1-LED frame (3 bytes/port < PREFILL 4), then idle
    #(FRAME_NS);
    csr(8'h01, 8'd0);
    reset_clk = 80000 * CLK_MHZ / 1000;
    frame(7, 3, $realtime + 1000.0);
    #(2_000_000.0);
    // E: frame-done pacing at the cap, 4 frames per latch type (frames 8..15).
    rises0 = fd_rises;
    per_max0 = 0.0;
    per_max1 = 0.0;
    for (f = 8; f < 16; f = f + 1) begin
      if (f == 12) begin
        wait (frame_done == 1'b1);
        csr(8'h01, 8'd1);  // WRITE_CSR keeps frame_done HIGH
        reset_clk = 300000 * CLK_MHZ / 1000;
      end
      wait (frame_done == 1'b1);
      #(WAKE_NS);
      if (frame_done !== 1'b1) begin
        $error("frame_done fell while idle");
        errors = errors + 1;
      end
      if (f != 8 && f != 12) begin
        per = $realtime - tprev;
        if (f < 12 && per > per_max0) per_max0 = per;
        if (f > 12 && per > per_max1) per_max1 = per;
      end
      tprev = $realtime;
      frame(f, CAP_LEDS * 3, $realtime);
    end
    wait (frame_done == 1'b1);
    #(1000.0);  // let the monitor count this edge
    $display("E (frame-done paced, %0d LEDs, +%0.0f us wake): period %0.3f ms @80us latch, %0.3f ms @300us latch (120 fps = %0.3f ms); frame_done rises=%0d",
             CAP_LEDS, WAKE_NS / 1000.0, per_max0 / 1.0e6, per_max1 / 1.0e6, FRAME_NS / 1.0e6,
             fd_rises - rises0);
    if (per_max0 > FRAME_NS || per_max1 > FRAME_NS || per_max0 == 0.0 || per_max1 == 0.0) begin
      $error("frame-done paced period exceeds the 120 fps period at the %0d-LED cap", CAP_LEDS);
      errors = errors + 1;
    end
    if (fd_rises - rises0 != 8) begin
      $error("expected 8 frame_done rising edges in phase E, got %0d", fd_rises - rises0);
      errors = errors + 1;
    end
    reset_clk = 80000 * CLK_MHZ / 1000;
    csr(8'h01, 8'd0);
    #(1_000_000.0);
    // (pad the expected list so phase-D frames index from DFIRST)
    for (f = 16; f < DFIRST; f = f + 1) exp_k[f] = 0;
    nexp = DFIRST;
    for (p = 0; p < MAX_PORTS; p = p + 1) fidx[p] = DFIRST;
    $display("A-C,E: frames_ok(port0)=%0d data_err=%0d count_err=%0d underruns=%0d min_fill=%0d max_byte_gap=%0d clk (one byte at %0.0f MHz = %0.1f clk)",
             frames_ok, data_err, count_err, st_underruns, st_min_fill, st_max_byte_gap, SCK_MHZ,
             8.0 * CLK_MHZ / SCK_MHZ);
    if (frames_ok != 16) begin
      $error("expected 16 clean frames on port 0 (4 A + 3 B + 1 C + 8 E), got %0d", frames_ok);
      errors = errors + 1;
    end
    errors = errors + data_err + count_err;
    if (st_underruns != 0) begin
      $error("underruns %0d with a continuous host", st_underruns);
      errors = errors + 1;
    end
    if (st_max_byte_gap > 16'(2 * 8 * CLK_MHZ / 18)) begin
      $error("max_byte_gap %0d clk >> one byte", st_max_byte_gap);
      errors = errors + 1;
    end
    // D: too early (7.0 ms cadence at 270 LEDs): expect merged frames
    t0 = $realtime + 1000.0;
    for (f = DFIRST; f < DFIRST + 3; f = f + 1) frame(f, 270 * 3, t0 + (f - DFIRST) * 7.0e6);
    #(12_000_000.0);
    $display("D (7.0 ms cadence, too early): merged-frame detections=%0d (expected > 0)", merged);
    if (merged == 0) begin
      $error("expected the too-early cadence to merge frames");
      errors = errors + 1;
    end
    $display("frame_done: %0d rising edges total, %0d invariant violations", fd_rises, fd_err);
    errors = errors + fd_err;
    if (errors == 0) $display("spi_ws281x_120fps_tb: PASS");
    else $fatal(1, "spi_ws281x_120fps_tb: %0d errors", errors);
    $finish;
  end
endmodule
