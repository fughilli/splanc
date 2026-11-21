`timescale 1ns / 1ps
// 20-port Tang Nano 9K top for Splanc MAX: 27 MHz crystal -> rPLL 54 MHz ->
// spi_ws281x with 20 pinned WS281x outputs + a frame-done pacing output.
//
// Pin map (tangnano9k_20p.cst): ports 0-7 on the 8-port top's pins 70-77 (so an
// 8-port harness keeps working), ports 8-19 on 40 35 41 42 51 53 54 55 56 57 68
// 69 (owner's choice, in that order), frame_done on pin 28 -> Pi GPIO 22 (header
// pin 15; confirmed by the owner 2026-10-26). All in the 3.3 V
// banks 1/2, which already carry the 8-port top's WS outputs and SPI inputs.
//
// frame_done (level, active HIGH) = every port has shifted out its frame AND the
// latch has elapsed, with no STREAM in progress. The Pi waits for its rising
// edge before starting the next SPI burst (README, "Frame-done pacing").
//
// STATS is on for the `underrun` strobe (sticky 100 ms flag on led[1]). The
// counters (underruns, min_fill, port_underruns, max_byte_gap) have no read-back
// path yet (no MISO pin), so synthesis removes them here.
//
// Parameters default to the 20-port MAX target and can be overridden with
// defines for scaling runs (scaling_report.sh drops the cst lines of unused ports):
//   TN9K_NUM_WS     ports (default 20; the cst pins at most 20)
//   TN9K_MAX_LEDS   LEDs per port (default 1024)
//   TN9K_FIFO_DEPTH bytes per port FIFO (default 2048 = one BSRAM; 0 = full frame)
//   TN9K_CLK_MHZ    core clock from the rPLL: 54 (x2) or 81 (x3)
`ifndef TN9K_NUM_WS
`define TN9K_NUM_WS 20
`endif
`ifndef TN9K_MAX_LEDS
`define TN9K_MAX_LEDS 1024
`endif
`ifndef TN9K_FIFO_DEPTH
`define TN9K_FIFO_DEPTH 2048
`endif
`ifndef TN9K_CLK_MHZ
`define TN9K_CLK_MHZ 54
`endif

module tangnano9k_20p_top #(
    parameter integer NUM_WS     = `TN9K_NUM_WS,
    parameter integer MAX_LEDS   = `TN9K_MAX_LEDS,
    parameter integer FIFO_DEPTH = `TN9K_FIFO_DEPTH,
    parameter integer CLK_MHZ    = `TN9K_CLK_MHZ
) (
    input  wire              clk27,      // 27 MHz crystal
    input  wire              ss,         // SPI chip select (active low)
    input  wire              sck,        // SPI clock
    input  wire              mosi,       // SPI data in
    output wire [NUM_WS-1:0] ws,         // WS281x outputs
    output wire              frame_done, // HIGH: frame emitted + latched, idle (Pi pacing)
    output wire [       5:0] led         // led[0] streaming; led[1] underrun flag; led[5:2] activity
);
  localparam integer FBDIV = CLK_MHZ / 27 - 1;  // 54 -> 1 (x2), 81 -> 2 (x3)
  wire clk;
  wire pll_lock;

  rPLL pll (
      .CLKOUT (clk),
      .LOCK   (pll_lock),
      .CLKOUTP(),
      .CLKOUTD(),
      .CLKOUTD3(),
      .CLKIN  (clk27),
      .CLKFB  (1'b0),
      .RESET  (1'b0),
      .RESET_P(1'b0),
      .FBDSEL (6'b0),
      .IDSEL  (6'b0),
      .ODSEL  (6'b0),
      .PSDA   (4'b0),
      .DUTYDA (4'b0),
      .FDLY   (4'b0)
  );
  defparam pll.DEVICE = "GW1NR-9C";
  defparam pll.FCLKIN = "27";
  defparam pll.FBDIV_SEL = FBDIV;
  defparam pll.IDIV_SEL = 0;
  defparam pll.ODIV_SEL = 8;  // VCO = CLK_MHZ*8 = 432 / 648 MHz (400-1200 range)
  defparam pll.CLKFB_SEL = "internal";
  defparam pll.CLKOUTD3_SRC = "CLKOUT";
  defparam pll.CLKOUTD_BYPASS = "true";
  defparam pll.CLKOUTD_SRC = "CLKOUT";
  defparam pll.CLKOUTP_BYPASS = "false";
  defparam pll.CLKOUTP_DLY_STEP = 0;
  defparam pll.CLKOUTP_FT_DIR = 1'b1;
  defparam pll.CLKOUT_BYPASS = "false";
  defparam pll.CLKOUT_DLY_STEP = 0;
  defparam pll.CLKOUT_FT_DIR = 1'b1;
  defparam pll.DUTYDA_SEL = "1000";
  defparam pll.DYN_DA_EN = "false";
  defparam pll.DYN_FBDIV_SEL = "false";
  defparam pll.DYN_IDIV_SEL = "false";
  defparam pll.DYN_ODIV_SEL = "false";
  defparam pll.DYN_SDIV_SEL = 2;
  defparam pll.PSDA_SEL = "0000";

  reg [9:0] rst_cnt = 10'd0;
  wire rst = ~rst_cnt[9];
  always @(posedge clk) begin
    if (pll_lock && !rst_cnt[9]) rst_cnt <= rst_cnt + 1'b1;
  end

  wire frame_pulse;
  wire underrun;

  spi_ws281x #(
      .MAX_PORTS (NUM_WS),
      .CLK_MHZ   (CLK_MHZ),
      .RESET_NS  (80000),
      .MAX_LEDS  (MAX_LEDS),
      .FIFO_DEPTH(FIFO_DEPTH),
      .STATS     (1)
  ) u_core (
      .clk (clk),
      .rst (rst),
      .ss  (ss),
      .sck (sck),
      .mosi(mosi),
      .ws  (ws),
      .frame_pulse(frame_pulse),
      .frame_done(frame_done),
      .underrun(underrun),
      .underruns(),
      .min_fill(),
      .port_underruns(),
      .max_byte_gap()
  );

  // Underrun health flag on led[1]: any FIFO underrun stretches to >= ~100 ms,
  // visible to the logic analyzer at any sample rate (and to a human).
  localparam integer STRETCH = CLK_MHZ * 100000;  // 100 ms of core clocks
  reg [$clog2(STRETCH+1)-1:0] ur_cnt = '0;
  always @(posedge clk) begin
    if (rst) ur_cnt <= '0;
    else if (underrun) ur_cnt <= $clog2(STRETCH+1)'(STRETCH);
    else if (ur_cnt != 0) ur_cnt <= ur_cnt - 1'b1;
  end
  wire ur_flag = (ur_cnt != 0);

  // Activity animation on led[5:2] (4 LEDs).
  reg [7:0] div_cnt = 8'd0;
  reg [2:0] pos = 3'd0;
  always @(posedge clk) begin
    if (rst) begin
      div_cnt <= 8'd0;
      pos     <= 3'd0;
    end else if (frame_pulse) begin
      if (div_cnt == 8'd3) begin
        div_cnt <= 8'd0;
        pos     <= (pos == 3'd3) ? 3'd0 : pos + 3'd1;
      end else begin
        div_cnt <= div_cnt + 8'd1;
      end
    end
  end
  assign led = {~(4'b0001 << pos[1:0]), ~ur_flag, frame_done};  // active low; led[0] lit while streaming
endmodule
