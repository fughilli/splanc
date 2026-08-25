// Byte-oriented SPI slave (mode 0: sample on rising SCK, MSB first).
//
// Ported/cleaned from ledsuit-fpga spi.v, trimmed to the write-only path we need
// for streaming (no MISO readback). Async SPI pins are brought into the `clk`
// domain through 2-FF synchronizers. `done` pulses for one `clk` when a full
// byte has been shifted in and is presented on `dout`.
module spi_slave (
    input  wire       clk,
    input  wire       rst,
    input  wire       ss,        // chip select, active low (async)
    input  wire       sck,       // SPI clock (async)
    input  wire       mosi,      // master-out slave-in (async)
    output reg  [7:0] dout,      // last received byte
    output reg        done,      // 1-clk strobe: `dout` valid
    output wire       selected   // = ~ss (synchronized)
);
  // 2-FF synchronizers for the asynchronous SPI inputs.
  reg [1:0] ss_sync, sck_sync, mosi_sync;
  always @(posedge clk) begin
    ss_sync   <= {ss_sync[0], ss};
    sck_sync  <= {sck_sync[0], sck};
    mosi_sync <= {mosi_sync[0], mosi};
  end
  wire ss_s = ss_sync[1];
  wire sck_s = sck_sync[1];
  wire mosi_s = mosi_sync[1];
  assign selected = ~ss_s;

  reg       sck_prev;
  reg [2:0] bit_cnt;
  reg [7:0] shreg;

  always @(posedge clk) begin
    done <= 1'b0;
    sck_prev <= sck_s;
    if (rst) begin
      bit_cnt  <= 3'd0;
      shreg    <= 8'd0;
      dout     <= 8'd0;
      sck_prev <= 1'b0;
    end else if (!selected) begin
      bit_cnt <= 3'd0;  // deselected: resync to a byte boundary
    end else if (~sck_prev & sck_s) begin  // rising SCK edge
      shreg <= {shreg[6:0], mosi_s};
      if (bit_cnt == 3'd7) begin
        dout    <= {shreg[6:0], mosi_s};
        done    <= 1'b1;
        bit_cnt <= 3'd0;
      end else begin
        bit_cnt <= bit_cnt + 3'd1;
      end
    end
  end
endmodule
