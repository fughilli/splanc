// Clocks bytes into spi_slave (mode 0, MSB first) and checks dout/done/selected.
`timescale 1ns / 1ps

module spi_slave_tb;
  reg clk = 0;
  always #1 clk = ~clk;

  reg        rst = 1;
  reg        ss = 1, sck = 0, mosi = 0;
  wire [7:0] dout;
  wire       done, selected;

  spi_slave dut (
      .clk(clk),
      .rst(rst),
      .ss(ss),
      .sck(sck),
      .mosi(mosi),
      .dout(dout),
      .done(done),
      .selected(selected)
  );

`ifdef TRACE
  initial begin
    $dumpfile("dump");
    $dumpvars(0, spi_slave_tb);
  end
`endif

  // Capture bytes as they complete.
  reg [7:0] got[0:7];
  integer   ngot = 0;
  always @(posedge clk) if (done) begin
    got[ngot] <= dout;
    ngot <= ngot + 1;
  end

  integer i, errors = 0;
  reg [7:0] test[0:2];

  // One SPI byte, mode 0: set MOSI, pulse SCK (sample on rising edge), MSB first.
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

  initial begin
    test[0] = 8'hA5;
    test[1] = 8'h3C;
    test[2] = 8'hFF;

    repeat (5) @(posedge clk);
    rst <= 0;
    repeat (2) @(posedge clk);

    if (selected !== 1'b0) begin
      $error("selected should be low when ss high");
      errors = errors + 1;
    end

    ss <= 1'b0;  // select
    repeat (2) @(posedge clk);
    if (selected !== 1'b1) begin
      $error("selected should be high when ss low");
      errors = errors + 1;
    end

    for (i = 0; i < 3; i = i + 1) spi_byte(test[i]);
    repeat (4) @(posedge clk);
    ss <= 1'b1;
    repeat (4) @(posedge clk);

    if (ngot != 3) begin
      $error("got %0d bytes, expected 3", ngot);
      errors = errors + 1;
    end
    for (i = 0; i < 3; i = i + 1)
    if (got[i] !== test[i]) begin
      $error("byte %0d: got %02x expected %02x", i, got[i], test[i]);
      errors = errors + 1;
    end

    if (errors == 0) $display("spi_slave_tb: PASS");
    else $fatal(1, "spi_slave_tb: %0d errors", errors);
    $finish;
  end
endmodule
