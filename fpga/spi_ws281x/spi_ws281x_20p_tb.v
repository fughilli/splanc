// Full path at MAX scale: SPI master -> spi_ws281x (20 ports, 1024 LEDs/port,
// 2048-byte per-port FIFOs, real WS2812 timing at a 54 MHz core) -> 20 WS outputs,
// with the SPI clock ASYNCHRONOUS to the core clock (real-valued delays), as the
// Pi drives it.
//
// Checks, on every port:
//   * every decoded byte equals the round-robin byte the master sent for that
//     port (so round-robin demux ordering is exact);
//   * every high pulse is exactly T0H or T1H core clocks (bit-exact WS281x);
//   * every bit period is PERIOD clocks (PERIOD+2 at a byte boundary: the FSM's
//     POP/LOAD cycles) -- any longer gap is a stall, and a stall > 50 us (the WS
//     latch) mid-frame is a hard failure;
//   * byte count = 3 * LEDs at the end;
//   * num_ports CSR clamps a write of 25 to 20 (MAX_PORTS);
//   * with num_ports = 13, ports 13..19 never go high (phase A);
//   * no FIFO overflow (sim-only `ovf`), reporting peak fill and stall count.
//
// Defines (verilog_sim `defines` / manual sweeps): TB_SCK_MHZ (default 18 -- the
// Pi 3's 400 MHz core / 22), TB_CLK_MHZ (54), TB_LEDS (1024), TB_FIFO_DEPTH
// (2048), TB_PREFILL (2), TB_KA (phase-A bytes/port, 24; must be >= PREFILL or
// the core never starts that frame), TB_GAP_NS / TB_GAP_AT (inject one SPI pause
// of GAP_NS before stream byte GAP_AT of phase B; 0 = none).
`timescale 1ns / 1ps

`ifndef TB_SCK_MHZ
`define TB_SCK_MHZ 18.0
`endif
`ifndef TB_CLK_MHZ
`define TB_CLK_MHZ 54
`endif
`ifndef TB_LEDS
`define TB_LEDS 1024
`endif
`ifndef TB_FIFO_DEPTH
`define TB_FIFO_DEPTH 2048
`endif
`ifndef TB_PREFILL
`define TB_PREFILL 2
`endif
`ifndef TB_KA
`define TB_KA 24
`endif
`ifndef TB_GAP_NS
`define TB_GAP_NS 0
`endif
`ifndef TB_GAP_AT
`define TB_GAP_AT 0
`endif

module spi_ws281x_20p_tb;
  localparam integer MAX_PORTS = 20;
  localparam integer CLK_MHZ = `TB_CLK_MHZ;
  localparam integer T0H_NS = 350, T1H_NS = 700, PERIOD_NS = 1250, RESET_NS = 80000;
  localparam integer LEDS = `TB_LEDS;
  localparam integer KB = 3 * LEDS;  // bytes per port, phase B
  localparam integer NP_A = 13;  // phase A active ports
  localparam integer KA = `TB_KA;  // phase A bytes per port (default 8 LEDs)

  localparam integer PERIOD_CLK = PERIOD_NS * CLK_MHZ / 1000;
  localparam integer T0H_CLK = T0H_NS * CLK_MHZ / 1000;
  localparam integer T1H_CLK = T1H_NS * CLK_MHZ / 1000;
  localparam integer MID = (T0H_CLK + T1H_CLK) / 2;
  localparam integer LATCH_CLK = 50 * CLK_MHZ;  // 50 us
  localparam real CLK_HALF = 500.0 / CLK_MHZ;  // ns
  localparam real SCK_HALF = 500.0 / `TB_SCK_MHZ;  // ns

  localparam [7:0] OP_WRITE_CSR = 8'h01, OP_STREAM = 8'h02;

  reg clk = 0;
  always #(CLK_HALF) clk = ~clk;

  reg                  rst = 1;
  reg                  ss = 1, sck = 0, mosi = 0;
  wire [MAX_PORTS-1:0] ws;
  wire                 frame_pulse;

  spi_ws281x #(
      .MAX_PORTS (MAX_PORTS),
      .CLK_MHZ   (CLK_MHZ),
      .T0H_NS    (T0H_NS),
      .T1H_NS    (T1H_NS),
      .PERIOD_NS (PERIOD_NS),
      .RESET_NS  (RESET_NS),
      .MAX_LEDS  (LEDS),
      .FIFO_DEPTH(`TB_FIFO_DEPTH),
      .PREFILL   (`TB_PREFILL)
  ) dut (
      .clk(clk),
      .rst(rst),
      .ss(ss),
      .sck(sck),
      .mosi(mosi),
      .ws(ws),
      .frame_pulse(frame_pulse)
  );

`ifdef TRACE
  initial begin
    $dumpfile("dump");
    $dumpvars(0, spi_ws281x_20p_tb);
  end
`endif

  // Deterministic per-port byte pattern (both bit values, varies per byte/port).
  function automatic [7:0] pat(input integer p, input integer k);
    pat = 8'((p * 73 + k * 29 + (k >> 5) * 7 + 32'h5A) ^ (k >> 3));
  endfunction

  // ---- per-port WS decoder + timing checker (core clock domain) ----
  integer cyc = 0;
  always @(posedge clk) cyc <= cyc + 1;

  integer    recvcnt  [0:MAX_PORTS-1];
  integer    bitcnt   [0:MAX_PORTS-1];
  reg  [7:0] acc      [0:MAX_PORTS-1];
  integer    hi_start [0:MAX_PORTS-1];
  integer    last_rise[0:MAX_PORTS-1];
  reg        was_high [0:MAX_PORTS-1];
  integer    data_err = 0, width_err = 0, period_err = 0, latch_err = 0, inactive_err = 0;
  integer    max_gap = 0;  // longest rise-to-rise inside a frame, clocks
  integer    np_active = MAX_PORTS;
  integer    phase_k = KB;
  integer    di, hilen, iv;
  reg        dbit;
  reg  [7:0] byte_v;

  always @(posedge clk) begin
    for (di = 0; di < MAX_PORTS; di = di + 1) begin
      if (ws[di] && !was_high[di]) begin
        if (di >= np_active) inactive_err = inactive_err + 1;
        if (last_rise[di] >= 0) begin
          iv = cyc - last_rise[di];
          if (iv > max_gap) max_gap = iv;
          if (iv != PERIOD_CLK && iv != PERIOD_CLK + 2) begin
            period_err = period_err + 1;
            if (iv > LATCH_CLK) latch_err = latch_err + 1;
          end
        end
        hi_start[di]  = cyc;
        last_rise[di] = cyc;
      end
      if (!ws[di] && was_high[di]) begin
        hilen = cyc - hi_start[di];
        if (hilen != T0H_CLK && hilen != T1H_CLK) width_err = width_err + 1;
        dbit = (hilen > MID);
        byte_v = {acc[di][6:0], dbit};
        acc[di] <= byte_v;
        if (bitcnt[di] == 7) begin
          if (byte_v !== pat(di, recvcnt[di])) begin
            if (data_err < 8)
              $display("port %0d byte %0d: got %02x expected %02x", di, recvcnt[di], byte_v,
                       pat(di, recvcnt[di]));
            data_err = data_err + 1;
          end
          recvcnt[di] = recvcnt[di] + 1;
          bitcnt[di]  = 0;
          // end of this port's frame: the next rise is a new frame, not a gap
          if (recvcnt[di] == phase_k) last_rise[di] = -1;
        end else begin
          bitcnt[di] = bitcnt[di] + 1;
        end
      end
      was_high[di] <= ws[di];
    end
  end

  // ---- SPI master, mode 0, MSB first, SCK async to clk ----
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

  task automatic csr_write(input [7:0] addr, input [7:0] val);
    begin
      ss = 1'b0;
      #(SCK_HALF * 2);
      spi_byte(OP_WRITE_CSR);
      spi_byte(addr);
      spi_byte(val);
      #(SCK_HALF * 2);
      ss = 1'b1;
      #(200.0);
    end
  endtask

  task automatic reset_decoders(input integer np, input integer k);
    integer p;
    begin
      np_active = np;
      phase_k   = k;
      for (p = 0; p < MAX_PORTS; p = p + 1) begin
        recvcnt[p]   = 0;
        bitcnt[p]    = 0;
        acc[p]       = 0;
        last_rise[p] = -1;
        hi_start[p]  = 0;
      end
    end
  endtask

  // One STREAM transaction: k bytes per port across np ports, round-robin, with
  // an optional single pause of gap_ns before stream byte gap_at.
  task automatic stream(input integer np, input integer k, input real gap_ns, input integer gap_at);
    integer i, p, n;
    begin
      ss = 1'b0;
      #(SCK_HALF * 2);
      spi_byte(OP_STREAM);
      n = 0;
      for (i = 0; i < k; i = i + 1)
      for (p = 0; p < np; p = p + 1) begin
        if (gap_ns > 0.0 && n == gap_at) #(gap_ns);
        spi_byte(pat(p, i));
        n = n + 1;
      end
      #(SCK_HALF * 2);
      ss = 1'b1;
    end
  endtask

  integer p, errors = 0;
  real t0;
  initial begin
    for (p = 0; p < MAX_PORTS; p = p + 1) was_high[p] = 0;
    reset_decoders(MAX_PORTS, KB);
    #(CLK_HALF * 10);
    rst = 0;
    #(CLK_HALF * 10);

    // ---------- phase A: num_ports = 13, short frame; ports 13..19 stay low ----
    csr_write(8'h00, NP_A[7:0]);
    if (dut.u_csr.num_ports !== 8'(NP_A)) begin
      $error("num_ports = %0d after writing %0d", dut.u_csr.num_ports, NP_A);
      errors = errors + 1;
    end
    reset_decoders(NP_A, KA);
    stream(NP_A, KA, 0.0, 0);
    #((KA * 8 * PERIOD_NS) + RESET_NS + 20000);
    for (p = 0; p < NP_A; p = p + 1)
    if (recvcnt[p] != KA) begin
      $error("phase A port %0d: %0d bytes, expected %0d", p, recvcnt[p], KA);
      errors = errors + 1;
    end
    $display("phase A (num_ports=13, 8 LEDs): data_err=%0d width_err=%0d inactive_err=%0d",
             data_err, width_err, inactive_err);

    // ---------- phase B: write 25 -> clamps to 20; full 20 x LEDS frame -------
    csr_write(8'h00, 8'd25);
    if (dut.u_csr.num_ports !== 8'd20) begin
      $error("num_ports clamp: wrote 25, got %0d (want 20)", dut.u_csr.num_ports);
      errors = errors + 1;
    end
    reset_decoders(MAX_PORTS, KB);
    t0 = $realtime;
    stream(MAX_PORTS, KB, `TB_GAP_NS, `TB_GAP_AT);
    $display("phase B: SPI stream took %0.3f ms at %0.1f MHz SCK (%0d bytes)",
             ($realtime - t0) / 1e6, `TB_SCK_MHZ, MAX_PORTS * KB + 1);
    #((KB * 8 * PERIOD_NS) + RESET_NS + 50000);
    for (p = 0; p < MAX_PORTS; p = p + 1)
    if (recvcnt[p] != KB) begin
      $error("phase B port %0d: %0d bytes, expected %0d", p, recvcnt[p], KB);
      errors = errors + 1;
    end

    $display("phase B (20 ports x %0d LEDs, FIFO %0d B): data_err=%0d width_err=%0d period_err=%0d latch_err=%0d inactive_err=%0d max_bit_gap=%0d clk (%0.2f us) ovf=%0d max_fill=%0d stalls=%0d",
             LEDS, `TB_FIFO_DEPTH, data_err, width_err, period_err, latch_err, inactive_err,
             max_gap, max_gap * 1.0 / CLK_MHZ, dut.u_stream.ovf, dut.u_stream.max_fill,
             dut.u_stream.stalls);
    errors = errors + data_err + width_err + inactive_err + latch_err;
    if (`TB_GAP_NS == 0) errors = errors + period_err;  // no stall allowed w/o gap
    if (dut.u_stream.ovf) begin
      $error("FIFO overflow (bytes dropped)");
      errors = errors + 1;
    end
    if (errors == 0) $display("spi_ws281x_20p_tb: PASS");
    else $fatal(1, "spi_ws281x_20p_tb: %0d errors", errors);
    $finish;
  end
endmodule
