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
    parameter integer RESET_NS  = 300000
) (
    input  wire                 clk,
    input  wire                 rst,
    input  wire                 ss,
    input  wire                 sck,
    input  wire                 mosi,
    output wire [MAX_PORTS-1:0] ws,
    output wire                 frame_pulse   // 1-cycle strobe per driven frame
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
      .RESET_NS(RESET_NS)
  ) u_stream (
      .clk(clk),
      .rst(rst),
      .num_ports(num_ports),
      .led_type(led_type),
      .stream_byte(stream_byte),
      .stream_valid(stream_valid),
      .stream_active(stream_active),
      .ws(ws),
      .frame_pulse(frame_pulse)
  );
endmodule
