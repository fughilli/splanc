// Full path: an SPI master writes the num_ports CSR, then streams a round-robin
// pixel frame. Each WS output is decoded by high-pulse width and checked per
// port; ports >= num_ports must stay low.
`timescale 1ns / 1ps

module spi_ws281x_tb;
  localparam integer MAX_PORTS = 4;
  localparam integer NP = 3;  // active ports (port 3 must stay low)
  localparam integer CLK_MHZ = 54;
  localparam integer T0H_NS = 350, T1H_NS = 700, PERIOD_NS = 1250, RESET_NS = 2000;
  localparam integer K = 3;  // bytes per port

  localparam integer PERIOD_CLK = PERIOD_NS * CLK_MHZ / 1000;
  localparam integer T0H_CLK = T0H_NS * CLK_MHZ / 1000;
  localparam integer T1H_CLK = T1H_NS * CLK_MHZ / 1000;
  localparam integer MID = (T0H_CLK + T1H_CLK) / 2;
  localparam integer BYTE_CLK = 8 * PERIOD_CLK;
  localparam integer SPI_BYTE_CLK = 8 * 4;  // 4 clks per SCK period

  localparam [7:0] OP_WRITE_CSR = 8'h01, OP_STREAM = 8'h02;

  reg clk = 0;
  always #1 clk = ~clk;

  reg               rst = 1;
  reg               ss = 1, sck = 0, mosi = 0;
  wire [MAX_PORTS-1:0] ws;

  spi_ws281x #(
      .MAX_PORTS(MAX_PORTS),
      .CLK_MHZ  (CLK_MHZ),
      .T0H_NS   (T0H_NS),
      .T1H_NS   (T1H_NS),
      .PERIOD_NS(PERIOD_NS),
      .RESET_NS (RESET_NS)
  ) dut (
      .clk(clk),
      .rst(rst),
      .ss(ss),
      .sck(sck),
      .mosi(mosi),
      .ws(ws)
  );

`ifdef TRACE
  initial begin
    $dumpfile("dump");
    $dumpvars(0, spi_ws281x_tb);
  end
`endif

  // ---- WS decoder (identical approach to ws281x_stream_tb) ----
  integer cyc = 0;
  always @(posedge clk) cyc <= cyc + 1;

  reg  [7:0] recv     [0:MAX_PORTS-1][0:K-1];
  integer    recvcnt  [0:MAX_PORTS-1];
  integer    bitcnt   [0:MAX_PORTS-1];
  reg  [7:0] acc      [0:MAX_PORTS-1];
  integer    hi_start [0:MAX_PORTS-1];
  reg        was_high [0:MAX_PORTS-1];
  integer    di, hilen;
  reg        dbit;
  always @(posedge clk) begin
    for (di = 0; di < MAX_PORTS; di = di + 1) begin
      if (ws[di] && !was_high[di]) hi_start[di] <= cyc;
      if (!ws[di] && was_high[di]) begin
        hilen = cyc - hi_start[di];
        dbit  = (hilen > MID);
        acc[di] <= {acc[di][6:0], dbit};
        if (bitcnt[di] == 7) begin
          recv[di][recvcnt[di]] <= {acc[di][6:0], dbit};
          recvcnt[di] <= recvcnt[di] + 1;
          bitcnt[di]  <= 0;
        end else begin
          bitcnt[di] <= bitcnt[di] + 1;
        end
      end
      was_high[di] <= ws[di];
    end
  end

  // ---- SPI master (mode 0, MSB first) ----
  task spi_byte(input [7:0] b);
    integer k;
    begin
      for (k = 7; k >= 0; k = k - 1) begin
        mosi <= b[k];
        repeat (2) @(posedge clk);
        sck <= 1'b1;
        repeat (2) @(posedge clk);
        sck <= 1'b0;
      end
    end
  endtask

  reg [7:0] frame[0:MAX_PORTS-1][0:K-1];
  integer p, k, errors = 0;

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
    repeat (4) @(posedge clk);

    // --- transaction 1: write num_ports CSR ---
    ss <= 1'b0;
    repeat (2) @(posedge clk);
    spi_byte(OP_WRITE_CSR);
    spi_byte(8'h00);  // CSR addr 0 = num_ports
    spi_byte(NP[7:0]);
    repeat (2) @(posedge clk);
    ss <= 1'b1;
    repeat (4) @(posedge clk);

    // --- transaction 2: stream K paced rounds ---
    ss <= 1'b0;
    repeat (2) @(posedge clk);
    spi_byte(OP_STREAM);
    for (k = 0; k < K; k = k + 1) begin
      for (p = 0; p < NP; p = p + 1) spi_byte(frame[p][k]);
      repeat (BYTE_CLK - NP * SPI_BYTE_CLK) @(posedge clk);
    end
    repeat (2) @(posedge clk);
    ss <= 1'b1;  // end of frame -> latch

    repeat (BYTE_CLK * 2) @(posedge clk);

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

    if (errors == 0) $display("spi_ws281x_tb: PASS");
    else $fatal(1, "spi_ws281x_tb: %0d errors", errors);
    $finish;
  end
endmodule
