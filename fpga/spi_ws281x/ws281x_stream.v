// Streaming, multi-port WS281x driver with per-port elastic FIFOs.
//
// SPI bytes arrive round-robin across the active ports (byte i -> port i mod
// num_ports) and are pushed into that port's FIFO. One shared timing FSM drives
// all active ports in lockstep: each WS byte-time it pops one byte from every
// active port's FIFO and shifts it out MSB-first, each port with its own T0H/T1H
// high-time.
//
// The FIFO decouples SPI arrival from WS emission: clock SPI FASTER than the
// strip drains, prefill a few bytes (PREFILL), then emit while SPI keeps filling.
// Because SPI outruns the drain, once started the FIFO only grows, so it never
// underflows mid-frame. Depth is one full frame per port (MAX_LEDS*3 bytes = one
// 18 Kbit BSRAM block for MAX_LEDS <= 768), so it can't overflow at any SPI rate.
// On stream-end (CS deasserts -> stream_active low) with the FIFOs drained, the
// FSM holds the >50us WS reset (latch), flushes, and idles for the next frame.
//
// num_ports (and, later, led_type -> timing preset) are runtime CSR inputs.

// ---------------------------------------------------------------------------
// Per-port synchronous FIFO: one write port (SPI demux) + one registered read
// port (WS FSM). Registered read => 1-cycle latency, which infers Gowin BSRAM
// for deep instances. `clr` clears it at reset / frame boundary.
// ---------------------------------------------------------------------------
module port_fifo #(
    parameter integer DEPTH = 1659,
    parameter integer AW    = 11
) (
    input  wire          clk,
    input  wire          clr,
    input  wire          wr_en,
    input  wire [   7:0] wr_data,
    input  wire          rd_en,
    output reg  [   7:0] rd_data,
    output wire [ AW:0]  count,
    output wire          empty,
    output wire          full
);
  reg [7:0]    mem [0:DEPTH-1];
  reg [AW-1:0] wptr = 0, rptr = 0;
  reg [AW:0]   cnt = 0;

  assign count = cnt;
  assign empty = (cnt == 0);
  assign full  = (cnt == DEPTH);

  wire do_wr = wr_en && (cnt != DEPTH);
  wire do_rd = rd_en && (cnt != 0);

  always @(posedge clk) begin
    if (clr) begin
      wptr <= 0;
      rptr <= 0;
      cnt  <= 0;
    end else begin
      if (do_wr) begin
        mem[wptr] <= wr_data;
        wptr <= (wptr == DEPTH - 1) ? 0 : wptr + 1'b1;
      end
      if (do_rd) begin
        rd_data <= mem[rptr];
        rptr <= (rptr == DEPTH - 1) ? 0 : rptr + 1'b1;
      end
      cnt <= cnt + (do_wr ? 1'b1 : 1'b0) - (do_rd ? 1'b1 : 1'b0);
    end
  end
endmodule


module ws281x_stream #(
    parameter integer MAX_PORTS = 16,
    parameter integer MAX_LEDS  = 553,
    parameter integer CLK_MHZ   = 54,
    parameter integer T0H_NS    = 350,
    parameter integer T1H_NS    = 700,
    parameter integer PERIOD_NS = 1250,
    parameter integer RESET_NS  = 300000,
    parameter integer PREFILL   = 2      // bytes/port buffered before emit starts
) (
    input  wire                 clk,
    input  wire                 rst,
    input  wire [          7:0] num_ports,
    input  wire [          7:0] led_type,      // reserved; WS281x only for now
    input  wire [          7:0] stream_byte,
    input  wire                 stream_valid,
    input  wire                 stream_active,
    output reg  [MAX_PORTS-1:0] ws
);
  localparam integer DEPTH = MAX_LEDS * 3;
  localparam integer AW = $clog2(DEPTH);
  localparam integer T0H = T0H_NS * CLK_MHZ / 1000;
  localparam integer T1H = T1H_NS * CLK_MHZ / 1000;
  localparam integer PERIOD = PERIOD_NS * CLK_MHZ / 1000;
  localparam integer RESET_TICKS = RESET_NS * CLK_MHZ / 1000;
  localparam integer CNT_W = $clog2(RESET_TICKS + 1);

  // Active-port mask (p < num_ports).
  wire [MAX_PORTS-1:0] active_mask;
  genvar gi;
  generate
    for (gi = 0; gi < MAX_PORTS; gi = gi + 1) begin : g_active
      assign active_mask[gi] = (gi < num_ports);
    end
  endgenerate

  reg [7:0] wr_port;  // round-robin SPI demux pointer

  localparam [2:0] S_IDLE = 3'd0, S_POP = 3'd1, S_LOAD = 3'd2,
                   S_DRIVE = 3'd3, S_WAIT = 3'd4, S_RESET = 3'd5;
  reg [2:0]        state;
  reg [CNT_W-1:0]  cnt;
  reg [2:0]        bit_idx;

  // Shared pop pulse (combinational): one cycle in S_POP -> each active FIFO
  // advances, data valid in the following S_LOAD cycle.
  wire rd_en = (state == S_POP);
  // Flush FIFOs + realign the demux at the end of a frame's reset latch.
  wire flush = (state == S_RESET) && (cnt == RESET_TICKS - 1);

  wire [7:0]  fdout [0:MAX_PORTS-1];
  wire [AW:0] fcnt  [0:MAX_PORTS-1];
  wire        fempty[0:MAX_PORTS-1];

  generate
    for (gi = 0; gi < MAX_PORTS; gi = gi + 1) begin : g_fifo
      wire wr = stream_valid && (wr_port == gi) && active_mask[gi];
      port_fifo #(
          .DEPTH(DEPTH),
          .AW   (AW)
      ) u_fifo (
          .clk    (clk),
          .clr    (rst | flush),
          .wr_en  (wr),
          .wr_data(stream_byte),
          .rd_en  (rd_en & active_mask[gi]),
          .rd_data(fdout[gi]),
          .count  (fcnt[gi]),
          .empty  (fempty[gi]),
          .full   ()
      );
    end
  endgenerate

  // Reductions over active ports: prefill met / no active FIFO empty.
  reg all_pre, all_ne;
  integer j;
  always @(*) begin
    all_pre = 1'b1;
    all_ne  = 1'b1;
    for (j = 0; j < MAX_PORTS; j = j + 1)
      if (j < num_ports) begin
        if (fcnt[j] < PREFILL) all_pre = 1'b0;
        if (fempty[j]) all_ne = 1'b0;
      end
  end

  reg [7:0] cur [0:MAX_PORTS-1];
  integer   i;

  always @(posedge clk) begin
    if (rst) begin
      state   <= S_IDLE;
      cnt     <= 0;
      bit_idx <= 3'd0;
      wr_port <= 8'd0;
      ws      <= {MAX_PORTS{1'b0}};
    end else begin
      // SPI byte -> round-robin demux pointer.
      if (stream_valid)
        wr_port <= (wr_port == num_ports - 8'd1) ? 8'd0 : wr_port + 8'd1;

      case (state)
        S_IDLE: begin
          ws <= {MAX_PORTS{1'b0}};
          if (stream_active && all_pre) state <= S_POP;
        end
        S_POP: begin  // rd_en asserted (comb); FIFOs advance this edge
          ws    <= {MAX_PORTS{1'b0}};
          state <= S_LOAD;
        end
        S_LOAD: begin  // popped byte now valid on fdout
          for (i = 0; i < MAX_PORTS; i = i + 1)
            if (active_mask[i]) cur[i] <= fdout[i];
          bit_idx <= 3'd0;
          cnt     <= 0;
          state   <= S_DRIVE;
        end
        S_DRIVE: begin
          for (i = 0; i < MAX_PORTS; i = i + 1)
            ws[i] <= active_mask[i] & (cnt < (cur[i][7] ? T1H : T0H));
          if (cnt == PERIOD - 1) begin
            cnt <= 0;
            if (bit_idx == 3'd7) begin
              if (all_ne) state <= S_POP;                 // seamless next byte
              else if (!stream_active) state <= S_RESET;  // frame done: latch
              else state <= S_WAIT;                       // underflow guard
            end else begin
              bit_idx <= bit_idx + 3'd1;
              for (i = 0; i < MAX_PORTS; i = i + 1)
                if (active_mask[i]) cur[i] <= {cur[i][6:0], 1'b0};
            end
          end else cnt <= cnt + 1'b1;
        end
        S_WAIT: begin
          ws <= {MAX_PORTS{1'b0}};
          if (!stream_active) state <= S_RESET;
          else if (all_ne) state <= S_POP;
        end
        S_RESET: begin
          ws <= {MAX_PORTS{1'b0}};
          if (cnt == RESET_TICKS - 1) begin
            wr_port <= 8'd0;
            cnt     <= 0;
            state   <= S_IDLE;
          end else cnt <= cnt + 1'b1;
        end
        default: state <= S_IDLE;
      endcase
    end
  end
endmodule
