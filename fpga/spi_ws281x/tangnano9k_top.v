// Tang Nano 9K top: 27 MHz crystal -> Gowin rPLL -> 54 MHz -> spi_ws281x.
//
// The rPLL is the plain Gowin primitive (synthesizable by yosys + apicula, no
// Gowin IDE / IP files). 27 MHz * (FBDIV_SEL+1)/(IDIV_SEL+1) = 27*2 = 54 MHz;
// ODIV_SEL=8 puts the VCO at 432 MHz (in the GW1N-9 400-1200 MHz range). See
// the Gowin IP Core Generator guide (SUG284) / juj's rPLL calculator.
module tangnano9k_top #(
    parameter integer NUM_WS = 8  // WS outputs wired to header pins (= MAX_PORTS)
) (
    input  wire              clk27,  // 27 MHz crystal
    input  wire              ss,     // SPI chip select (active low)
    input  wire              sck,    // SPI clock
    input  wire              mosi,   // SPI data in
    output wire [NUM_WS-1:0] ws,     // WS281x outputs
    output wire [       5:0] led     // 6 onboard LEDs (active low) — activity anim
);
  wire clk54;
  wire pll_lock;

  rPLL pll (
      .CLKOUT (clk54),
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
  defparam pll.FBDIV_SEL = 1;  // x2
  defparam pll.IDIV_SEL = 0;  // /1
  defparam pll.ODIV_SEL = 8;  // VCO = 54*8 = 432 MHz
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

  // Reset: held until the PLL locks, then a few hundred cycles more.
  reg [9:0] rst_cnt = 10'd0;
  wire rst = ~rst_cnt[9];
  always @(posedge clk54) begin
    if (pll_lock && !rst_cnt[9]) rst_cnt <= rst_cnt + 1'b1;
  end

  wire frame_pulse;

  spi_ws281x #(
      .MAX_PORTS(NUM_WS),
      .CLK_MHZ  (54),
      .RESET_NS (80000)   // WS2812/B latch >50us; fits 60Hz/550-LED refresh budget
  ) u_core (
      .clk (clk54),
      .rst (rst),
      .ss  (ss),
      .sck (sck),
      .mosi(mosi),
      .ws  (ws),
      .frame_pulse(frame_pulse)
  );

  // Onboard-LED activity animation: a Cylon bounce across the 6 LEDs that steps
  // once every ANIM_DIV driven frames -- a visible "SPI frames are streaming"
  // heartbeat at a clean divider of the frame clock. Frozen (last LED held) when
  // no frames arrive.
  localparam integer ANIM_DIV = 4;
  reg [7:0] div_cnt = 8'd0;
  reg [3:0] phase = 4'd0;  // 0..9 ping-pong over the 6 LEDs
  always @(posedge clk54) begin
    if (rst) begin
      div_cnt <= 8'd0;
      phase   <= 4'd0;
    end else if (frame_pulse) begin
      if (div_cnt == ANIM_DIV - 1) begin
        div_cnt <= 8'd0;
        phase   <= (phase == 4'd9) ? 4'd0 : phase + 4'd1;
      end else begin
        div_cnt <= div_cnt + 8'd1;
      end
    end
  end
  // phase 0..5 -> pos 0..5, phase 6..9 -> pos 4..1 (bounce)
  wire [2:0] pos = (phase <= 4'd5) ? phase[2:0] : (4'd10 - phase);
  assign led = ~(6'b000001 << pos);  // active low: lit LED at `pos`
endmodule
