// Tests the streaming core directly. Feeds a round-robin byte stream FAST (SPI
// far outrunning the WS drain -- the case the old 2-byte-buffer core truncated)
// into the per-port FIFOs, decodes each WS output by high-pulse width back into
// bytes, and checks every byte emits per port, inactive ports stay low, and the
// count is exactly right (no dropped or duplicated LEDs).
`timescale 1ns / 1ps

module ws281x_stream_tb;
  localparam integer MAX_PORTS = 4;
  localparam integer NP = 3;  // active ports (port 3 must stay low)
  localparam integer MAX_LEDS = 8;  // DEPTH = 24 bytes/port
  localparam integer CLK_MHZ = 54;
  localparam integer T0H_NS = 350, T1H_NS = 700, PERIOD_NS = 1250, RESET_NS = 2000;
  localparam integer PREFILL = 2;
  localparam integer K = 6;  // bytes per port in the frame (2 LEDs)

  localparam integer PERIOD_CLK = PERIOD_NS * CLK_MHZ / 1000;
  localparam integer T0H_CLK = T0H_NS * CLK_MHZ / 1000;
  localparam integer T1H_CLK = T1H_NS * CLK_MHZ / 1000;
  localparam integer MID = (T0H_CLK + T1H_CLK) / 2;
  localparam integer BYTE_CLK = 8 * PERIOD_CLK;

  reg clk = 0;
  always #1 clk = ~clk;

  reg                  rst = 1;
  reg  [          7:0] num_ports = NP;
  reg  [          7:0] led_type = 0;
  reg  [          7:0] stream_byte = 0;
  reg                  stream_valid = 0;
  reg                  stream_active = 0;
  wire [MAX_PORTS-1:0] ws;

  ws281x_stream #(
      .MAX_PORTS(MAX_PORTS),
      .MAX_LEDS (MAX_LEDS),
      .CLK_MHZ  (CLK_MHZ),
      .T0H_NS   (T0H_NS),
      .T1H_NS   (T1H_NS),
      .PERIOD_NS(PERIOD_NS),
      .RESET_NS (RESET_NS),
      .PREFILL  (PREFILL)
  ) dut (
      .clk(clk),
      .rst(rst),
      .num_ports(num_ports),
      .led_type(led_type),
      .stream_byte(stream_byte),
      .stream_valid(stream_valid),
      .stream_active(stream_active),
      .ws(ws)
  );

`ifdef TRACE
  initial begin
    $dumpfile("dump");
    $dumpvars(0, ws281x_stream_tb);
  end
`endif

  // ---- expected frame data (distinct, easy to eyeball) ----
  reg [7:0] frame[0:MAX_PORTS-1][0:K-1];

  // ---- per-port WS decoder (high-pulse-width -> bits -> bytes) ----
  integer cyc = 0;
  always @(posedge clk) cyc <= cyc + 1;

  reg  [7:0] recv     [0:MAX_PORTS-1][0:K-1];
  integer    recvcnt  [0:MAX_PORTS-1];
  integer    bitcnt   [0:MAX_PORTS-1];
  reg  [7:0] acc      [0:MAX_PORTS-1];
  integer    hi_start [0:MAX_PORTS-1];
  reg        was_high [0:MAX_PORTS-1];

  integer di;
  integer hilen;
  reg     dbit;
  always @(posedge clk) begin
    for (di = 0; di < MAX_PORTS; di = di + 1) begin
      if (ws[di] && !was_high[di]) hi_start[di] <= cyc;
      if (!ws[di] && was_high[di]) begin
        hilen = cyc - hi_start[di];
        dbit  = (hilen > MID);
        acc[di] <= {acc[di][6:0], dbit};
        if (bitcnt[di] == 7) begin
          if (recvcnt[di] < K) recv[di][recvcnt[di]] <= {acc[di][6:0], dbit};
          recvcnt[di] <= recvcnt[di] + 1;
          bitcnt[di]  <= 0;
        end else begin
          bitcnt[di] <= bitcnt[di] + 1;
        end
      end
      was_high[di] <= ws[di];
    end
  end

  // ---- stimulus ----
  integer p, k, errors = 0;
  // Fast SPI byte: valid for one cycle, one gap cycle -- no byte-time pacing, so
  // the whole frame lands in the FIFO far faster than the strip drains.
  task send_byte(input [7:0] b);
    begin
      stream_byte  <= b;
      stream_valid <= 1'b1;
      @(posedge clk);
      stream_valid <= 1'b0;
      @(posedge clk);
    end
  endtask

  initial begin
    for (p = 0; p < MAX_PORTS; p = p + 1) begin
      recvcnt[p] = 0;
      bitcnt[p]  = 0;
      acc[p]     = 0;
      was_high[p] = 0;
      hi_start[p] = 0;
      for (k = 0; k < K; k = k + 1) frame[p][k] = (p[3:0] << 4) | k[3:0];
    end

    repeat (5) @(posedge clk);
    rst <= 0;
    @(posedge clk);
    stream_active <= 1'b1;

    // Dump the whole frame round-robin as fast as the bus allows.
    for (k = 0; k < K; k = k + 1)
      for (p = 0; p < NP; p = p + 1) send_byte(frame[p][k]);

    // End the frame almost immediately -- SPI has delivered everything but the
    // strip is only ~1 byte into emission, so the FSM must drain the still-full
    // FIFO AFTER stream_active drops (the real fast-SPI case). No byte may be lost.
    repeat (BYTE_CLK) @(posedge clk);
    stream_active <= 1'b0;
    repeat (BYTE_CLK * (K + 4)) @(posedge clk);

    // ---- checks ----
    for (p = 0; p < NP; p = p + 1) begin
      if (recvcnt[p] != K) begin
        $error("port %0d: got %0d bytes, expected %0d", p, recvcnt[p], K);
        errors = errors + 1;
      end
      for (k = 0; k < K; k = k + 1)
      if (recv[p][k] !== frame[p][k]) begin
        $error("port %0d byte %0d: got %02x expected %02x", p, k, recv[p][k], frame[p][k]);
        errors = errors + 1;
      end
    end
    for (p = NP; p < MAX_PORTS; p = p + 1)
    if (recvcnt[p] != 0) begin
      $error("inactive port %0d drove %0d bytes", p, recvcnt[p]);
      errors = errors + 1;
    end

    if (errors == 0) $display("ws281x_stream_tb: PASS");
    else $fatal(1, "ws281x_stream_tb: %0d errors", errors);
    $finish;
  end
endmodule
