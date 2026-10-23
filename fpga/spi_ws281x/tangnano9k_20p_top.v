`timescale 1ns / 1ps
// INTERNAL-ONLY 20-port variant of the Tang Nano 9K top, for resource / timing /
// simulation sign-off before the WS output pin map is chosen. NOT for flashing:
// it has no WS output pins.
//
// Why the outputs are folded: with no top-level ws[] pins, yosys would remove
// every port's FIFO + driver as dead logic and the utilisation/fmax numbers would
// be fake. Instead all NUM_WS outputs are XOR-reduced into one onboard LED pin
// (led[0]): every port's output still reaches a real pin, so every port's
// datapath survives synthesis and is placed and routed. The per-port FF/LUT/BSRAM
// counts scaling 8 -> 16 -> 20 (fx-gpu-lowering.md / the PR) confirm it.
// led[5:1] keep the frame-activity animation of the 8-pin top.
//
// Parameters default to the 20-port MAX target and can be overridden with
// defines for scaling runs (yosys -D / verilog_top defines):
//   TN9K_NUM_WS     ports (default 20)
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
    input  wire       clk27,  // 27 MHz crystal
    input  wire       ss,     // SPI chip select (active low)
    input  wire       sck,    // SPI clock
    input  wire       mosi,   // SPI data in
    output wire [5:0] led     // led[0] = XOR of all WS outputs; led[5:1] activity
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

  wire [NUM_WS-1:0] ws;
  wire              frame_pulse;

  spi_ws281x #(
      .MAX_PORTS (NUM_WS),
      .CLK_MHZ   (CLK_MHZ),
      .RESET_NS  (80000),
      .MAX_LEDS  (MAX_LEDS),
      .FIFO_DEPTH(FIFO_DEPTH)
  ) u_core (
      .clk (clk),
      .rst (rst),
      .ss  (ss),
      .sck (sck),
      .mosi(mosi),
      .ws  (ws),
      .frame_pulse(frame_pulse)
  );

  // Output termination: one registered XOR of every port -> a real pin.
  reg ws_fold = 1'b0;
  always @(posedge clk) ws_fold <= ^ws;

  // Activity animation on led[5:1] (as in tangnano9k_top, 5 LEDs).
  reg [7:0] div_cnt = 8'd0;
  reg [2:0] pos = 3'd0;
  always @(posedge clk) begin
    if (rst) begin
      div_cnt <= 8'd0;
      pos     <= 3'd0;
    end else if (frame_pulse) begin
      if (div_cnt == 8'd3) begin
        div_cnt <= 8'd0;
        pos     <= (pos == 3'd4) ? 3'd0 : pos + 3'd1;
      end else begin
        div_cnt <= div_cnt + 8'd1;
      end
    end
  end
  assign led = {~(5'b00001 << pos), ~ws_fold};  // active low
endmodule
