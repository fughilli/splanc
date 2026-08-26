// Control/status register bank, written over SPI (see spi_ctrl.v).
//
// Byte-addressed. Currently:
//   0x00  num_ports : active output count (1..MAX_PORTS), clamped on write.
//   0x01  led_type  : LED family / timing preset index. 0 = WS2812/WS281x.
//                     Reserved for future presets (SK6812, APA, ...) -- the
//                     field exists now so the wire protocol is stable; the
//                     streaming core currently implements the WS281x preset.
module csr #(
    parameter MAX_PORTS = 16
) (
    input  wire       clk,
    input  wire       rst,
    input  wire       we,
    input  wire [7:0] addr,
    input  wire [7:0] wdata,
    output reg  [7:0] num_ports,
    output reg  [7:0] led_type
);
  localparam [7:0] ADDR_NUM_PORTS = 8'h00;
  localparam [7:0] ADDR_LED_TYPE = 8'h01;

  always @(posedge clk) begin
    if (rst) begin
      num_ports <= MAX_PORTS[7:0];  // default: all ports active
      led_type  <= 8'h00;  // default: WS2812/WS281x
    end else if (we) begin
      case (addr)
        ADDR_NUM_PORTS:
        // Clamp to [1, MAX_PORTS] so the core's round-robin modulus is sane.
        num_ports <= (wdata == 8'd0) ? 8'd1 :
            (wdata > MAX_PORTS[7:0]) ? MAX_PORTS[7:0] : wdata;
        ADDR_LED_TYPE: led_type <= wdata;
        default: ;  // ignore unknown addresses
      endcase
    end
  end
endmodule
