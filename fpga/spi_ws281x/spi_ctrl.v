// SPI transaction framing: decode the opcode byte after CS-low and route the
// following bytes to either the CSR bank or the streaming pixel path.
//
//   CS low
//     opcode:
//       0x01 WRITE_CSR : addr byte, then value byte(s) written to addr, addr+1,
//                        ... (auto-increment) -- burst CSR writes.
//       0x02 STREAM    : remaining bytes are round-robin pixel data; asserts
//                        `stream_active` for the streaming core, which latches
//                        (WS reset) when CS deasserts.
//   CS high
module spi_ctrl (
    input  wire       clk,
    input  wire       rst,
    // From spi_slave:
    input  wire [7:0] spi_dout,
    input  wire       spi_done,
    input  wire       spi_selected,
    // CSR write port:
    output reg        csr_we,
    output reg  [7:0] csr_addr,
    output reg  [7:0] csr_wdata,
    // Streaming pixel port:
    output reg  [7:0] stream_byte,
    output reg        stream_valid,
    output reg        stream_active
);
  localparam [7:0] OP_WRITE_CSR = 8'h01;
  localparam [7:0] OP_STREAM = 8'h02;

  localparam [2:0] S_IDLE = 3'd0, S_OPCODE = 3'd1, S_CSR_ADDR = 3'd2,
      S_CSR_DATA = 3'd3, S_STREAM = 3'd4, S_DRAIN = 3'd5;

  reg [2:0] state;
  reg [7:0] waddr;  // running CSR write pointer (auto-increment)

  always @(posedge clk) begin
    // Default: strobes low each cycle.
    csr_we <= 1'b0;
    stream_valid <= 1'b0;

    if (rst) begin
      state <= S_IDLE;
      stream_active <= 1'b0;
      csr_addr <= 8'd0;
      csr_wdata <= 8'd0;
      stream_byte <= 8'd0;
      waddr <= 8'd0;
    end else if (!spi_selected) begin
      // CS deasserted: end any transaction (streaming core sees stream_active
      // drop and latches).
      state <= S_IDLE;
      stream_active <= 1'b0;
    end else begin
      case (state)
        S_IDLE: state <= S_OPCODE;  // just selected; await the opcode byte
        S_OPCODE:
        if (spi_done) begin
          case (spi_dout)
            OP_WRITE_CSR: state <= S_CSR_ADDR;
            OP_STREAM: begin
              state <= S_STREAM;
              stream_active <= 1'b1;
            end
            default: state <= S_DRAIN;  // unknown opcode: ignore rest of txn
          endcase
        end
        S_CSR_ADDR:
        if (spi_done) begin
          waddr <= spi_dout;
          state <= S_CSR_DATA;
        end
        S_CSR_DATA:
        if (spi_done) begin
          csr_we    <= 1'b1;
          csr_addr  <= waddr;  // write current byte to the current pointer...
          csr_wdata <= spi_dout;
          waddr     <= waddr + 8'd1;  // ...and advance for the next value
        end
        S_STREAM:
        if (spi_done) begin
          stream_valid <= 1'b1;
          stream_byte  <= spi_dout;
        end
        S_DRAIN: ;  // swallow the rest of an unknown transaction
        default: state <= S_IDLE;
      endcase
    end
  end
endmodule
