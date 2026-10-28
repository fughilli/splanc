`timescale 1ns / 1ps
// SPI -> streaming WS281x, top of the reusable core.
//
//   spi_slave (bytes) -> spi_ctrl (opcode framing) -> { csr, ws281x_stream }
//
// SPI is mode 0, MSB first. See spi_ctrl.v for the transaction protocol and
// csr.v for the register map. `ws` carries the MAX_PORTS WS281x outputs (ports
// >= num_ports stay low).
module spi_ws281x #(
    parameter integer MAX_PORTS = 16,
    parameter integer CLK_MHZ   = 54,
    parameter integer T0H_NS    = 350,
    parameter integer T1H_NS    = 700,
    parameter integer PERIOD_NS = 1250,
    parameter integer RESET_NS  = 300000,
    parameter integer MAX_LEDS  = 553,    // per-port frame capacity (FIFO default)
    parameter integer FIFO_DEPTH = 0,     // per-port FIFO bytes; 0 = MAX_LEDS*3
    parameter integer PREFILL   = 2,      // bytes/port buffered before a frame starts
    parameter integer RESET_ALT_NS = 300000,  // latch for led_type 1 (WS2812B-V5/SK6812)
    parameter integer STATS     = 0       // 1 = self-instrumentation (see outputs)
) (
    input  wire                 clk,
    input  wire                 rst,
    input  wire                 ss,
    input  wire                 sck,
    input  wire                 mosi,
    output wire [MAX_PORTS-1:0] ws,
    output wire                 frame_pulse,  // 1-cycle strobe per driven frame
    output wire                 frame_done,   // level: frame emitted + latched, idle (host pacing)
    // STATS outputs (constant 0 when STATS == 0), cumulative since reset:
    output wire                 underrun,     // 1-cycle strobe: a FIFO ran dry mid-frame
    output wire [         15:0] underruns,    // saturating stall count
    output wire [         15:0] min_fill,     // lowest FIFO level seen while streaming
    output wire [8*MAX_PORTS-1:0] port_underruns,  // per-port 8-bit stall counts
    output reg  [         15:0] max_byte_gap  // longest byte-to-byte interval with CS low, clk cycles
);
  wire [7:0] spi_dout;
  wire       spi_done;
  wire       spi_selected;

  spi_slave u_spi (
      .clk(clk),
      .rst(rst),
      .ss(ss),
      .sck(sck),
      .mosi(mosi),
      .dout(spi_dout),
      .done(spi_done),
      .selected(spi_selected)
  );

  wire       csr_we;
  wire [7:0] csr_addr;
  wire [7:0] csr_wdata;
  wire [7:0] stream_byte;
  wire       stream_valid;
  wire       stream_active;

  spi_ctrl u_ctrl (
      .clk(clk),
      .rst(rst),
      .spi_dout(spi_dout),
      .spi_done(spi_done),
      .spi_selected(spi_selected),
      .csr_we(csr_we),
      .csr_addr(csr_addr),
      .csr_wdata(csr_wdata),
      .stream_byte(stream_byte),
      .stream_valid(stream_valid),
      .stream_active(stream_active)
  );

  wire [7:0] num_ports;
  wire [7:0] led_type;

  csr #(
      .MAX_PORTS(MAX_PORTS)
  ) u_csr (
      .clk(clk),
      .rst(rst),
      .we(csr_we),
      .addr(csr_addr),
      .wdata(csr_wdata),
      .num_ports(num_ports),
      .led_type(led_type)
  );

  ws281x_stream #(
      .MAX_PORTS(MAX_PORTS),
      .CLK_MHZ(CLK_MHZ),
      .T0H_NS(T0H_NS),
      .T1H_NS(T1H_NS),
      .PERIOD_NS(PERIOD_NS),
      .RESET_NS(RESET_NS),
      .MAX_LEDS(MAX_LEDS),
      .FIFO_DEPTH(FIFO_DEPTH),
      .PREFILL(PREFILL),
      .RESET_ALT_NS(RESET_ALT_NS),
      .STATS(STATS)
  ) u_stream (
      .clk(clk),
      .rst(rst),
      .num_ports(num_ports),
      .led_type(led_type),
      .stream_byte(stream_byte),
      .stream_valid(stream_valid),
      .stream_active(stream_active),
      .ws(ws),
      .frame_pulse(frame_pulse),
      .frame_done(frame_done),
      .underrun(underrun),
      .underruns(underruns),
      .min_fill(min_fill),
      .port_underruns(port_underruns)
  );

  // SCK-idle meter (STATS): the longest interval between consecutive received
  // bytes while CS stays low, at the core clock. One byte at SCK f takes
  // 8 / f; anything beyond that is a host-side pause (DMA chunk boundary,
  // scheduling). Measured from the first byte of each transaction.
  generate
    if (STATS != 0) begin : g_idle
      reg [15:0] idle_cnt;
      reg        armed;
      always @(posedge clk) begin
        if (rst) begin
          idle_cnt     <= 16'd0;
          armed        <= 1'b0;
          max_byte_gap <= 16'd0;
        end else if (!spi_selected) begin
          idle_cnt <= 16'd0;
          armed    <= 1'b0;
        end else if (spi_done) begin
          if (armed && idle_cnt > max_byte_gap) max_byte_gap <= idle_cnt;
          armed    <= 1'b1;
          idle_cnt <= 16'd0;
        end else if (idle_cnt != 16'hFFFF) begin
          idle_cnt <= idle_cnt + 16'd1;
        end
      end
    end else begin : g_noidle
      always @(posedge clk) max_byte_gap <= 16'd0;
    end
  endgenerate
endmodule
