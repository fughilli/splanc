// Streaming, multi-port WS281x driver.
//
// Instead of buffering a whole frame in block RAM, this consumes the SPI byte
// stream on the fly. Bytes arrive round-robin across the active ports
// (byte i -> port i mod num_ports); each port keeps only a 2-byte double buffer
// (a `cur` byte being shifted out and a `nxt` byte filling from SPI). One shared
// timing FSM drives all active ports in lockstep -- every port emits the same
// bit index at the same time, each with its own T0H/T1H high-time. This works
// because SPI delivers >= num_ports bytes per WS byte-time (the caller's
// guarantee), so `nxt` is refilled before each byte-time boundary.
//
// num_ports (and, in future, led_type -> timing preset) are runtime inputs from
// the CSR bank. Only the WS281x/WS2812 timing preset is implemented today.
module ws281x_stream #(
    parameter integer MAX_PORTS = 16,
    parameter integer CLK_MHZ   = 54,
    // WS2812 timing (ns). Bit = high pulse then low; 0/1 differ in high time.
    parameter integer T0H_NS    = 350,
    parameter integer T1H_NS    = 700,
    parameter integer PERIOD_NS = 1250,
    parameter integer RESET_NS  = 300000
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
  // Tick counts (ns * MHz / 1000 keeps the products in 32 bits).
  localparam integer T0H = T0H_NS * CLK_MHZ / 1000;
  localparam integer T1H = T1H_NS * CLK_MHZ / 1000;
  localparam integer PERIOD = PERIOD_NS * CLK_MHZ / 1000;
  localparam integer RESET_TICKS = RESET_NS * CLK_MHZ / 1000;
  localparam integer CNT_W = $clog2(RESET_TICKS + 1);

  // Which ports are active (p < num_ports).
  wire [MAX_PORTS-1:0] active_mask;
  genvar gi;
  generate
    for (gi = 0; gi < MAX_PORTS; gi = gi + 1) begin : g_amask
      assign active_mask[gi] = (gi < num_ports);
    end
  endgenerate

  // Per-port double buffer.
  reg [            7:0] cur     [0:MAX_PORTS-1];
  reg [            7:0] nxt     [0:MAX_PORTS-1];
  reg [MAX_PORTS-1:0]   nxt_full;

  reg [            7:0] wr_port;  // round-robin write pointer
  reg [CNT_W-1:0]       cnt;      // within-bit tick / reset tick
  reg [            2:0] bit_idx;  // 0..7, MSB first

  localparam [1:0] S_IDLE = 2'd0, S_DRIVE = 2'd1, S_WAIT = 2'd2, S_RESET = 2'd3;
  reg [1:0] state;

  // A round is ready when every active port has its next byte buffered.
  wire all_ready = &(nxt_full | ~active_mask);

  integer i;
  reg load;   // this cycle: cur[*] <= nxt[*] for active ports
  reg shift;  // this cycle: cur[*] <= cur[*] << 1 for active ports

  always @(posedge clk) begin
    load  = 1'b0;
    shift = 1'b0;

    if (rst) begin
      state    <= S_IDLE;
      cnt      <= 0;
      bit_idx  <= 3'd0;
      wr_port  <= 8'd0;
      nxt_full <= {MAX_PORTS{1'b0}};
      ws       <= {MAX_PORTS{1'b0}};
    end else begin
      // --- SPI byte -> round-robin demux into `nxt` ---
      if (stream_valid) begin
        nxt[wr_port] <= stream_byte;
        wr_port <= (wr_port == num_ports - 8'd1) ? 8'd0 : wr_port + 8'd1;
      end

      // --- shared timing FSM ---
      case (state)
        S_IDLE: begin
          if (stream_active && all_ready) begin
            load    = 1'b1;
            bit_idx <= 3'd0;
            cnt     <= 0;
            state   <= S_DRIVE;
          end
        end
        S_DRIVE: begin
          if (cnt == PERIOD - 1) begin
            cnt <= 0;
            if (bit_idx == 3'd7) begin
              bit_idx <= 3'd0;
              if (all_ready) begin
                load = 1'b1;  // seamless next byte
              end else if (!stream_active) begin
                state <= S_RESET;  // frame done: latch
              end else begin
                state <= S_WAIT;  // underflow guard (caller violated the rate)
              end
            end else begin
              bit_idx <= bit_idx + 3'd1;
              shift   = 1'b1;
            end
          end else begin
            cnt <= cnt + 1'b1;
          end
        end
        S_WAIT: begin
          if (!stream_active) begin
            state <= S_RESET;
            cnt   <= 0;
          end else if (all_ready) begin
            load    = 1'b1;
            bit_idx <= 3'd0;
            cnt     <= 0;
            state   <= S_DRIVE;
          end
        end
        S_RESET: begin
          if (cnt == RESET_TICKS - 1) begin
            wr_port <= 8'd0;
            state   <= S_IDLE;
          end else begin
            cnt <= cnt + 1'b1;
          end
        end
        default: state <= S_IDLE;
      endcase

      // --- per-port outputs + buffer updates ---
      for (i = 0; i < MAX_PORTS; i = i + 1) begin
        // WS waveform: high at bit start, drop at this port's T0H/T1H.
        if (state == S_DRIVE)
          ws[i] <= active_mask[i] & (cnt < (cur[i][7] ? T1H : T0H));
        else ws[i] <= 1'b0;

        // nxt_full: a demux write (set) beats a load-consume (clear) so a byte
        // arriving on the same cycle it's consumed is retained for next round.
        if (stream_valid && (wr_port == i[7:0])) nxt_full[i] <= 1'b1;
        else if (load && active_mask[i]) nxt_full[i] <= 1'b0;

        // cur: load next byte, else shift out the MSB.
        if (load && active_mask[i]) cur[i] <= nxt[i];
        else if (shift && active_mask[i]) cur[i] <= {cur[i][6:0], 1'b0};
      end

      // Clear buffers when a frame ends so the next frame starts clean.
      if (state == S_RESET && cnt == RESET_TICKS - 1) nxt_full <= {MAX_PORTS{1'b0}};
    end
  end
endmodule
