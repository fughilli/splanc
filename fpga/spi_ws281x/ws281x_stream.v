`timescale 1ns / 1ps
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
// underflows mid-frame. By default the depth is one full frame per port
// (MAX_LEDS*3 bytes = one 18 Kbit BSRAM block for MAX_LEDS <= 682), so it can't
// overflow at any SPI rate. FIFO_DEPTH overrides that: with SPI at r x the drain
// rate the peak fill is ~frame_bytes * (1 - 1/r) + PREFILL, so a shallower FIFO
// (e.g. 2048 B = one BSRAM for 1024-LED ports at r <= ~3) is enough and keeps 20
// ports inside the GW1NR-9's 26 BSRAM blocks. If a FIFO ever empties mid-frame
// the line is held low in S_WAIT; a stall longer than the WS latch (>50 us)
// splits the frame, so the host must keep SPI ahead of the drain.
// On stream-end (CS deasserts -> stream_active low) with the FIFOs drained, the
// FSM holds the >50us WS reset (latch) and idles for the next frame. Bytes of
// the NEXT frame that arrive during the latch are kept (they wait in the FIFO and
// emit right after it), so a host whose next CS lands a little early -- pacing
// jitter at a 120 fps cadence -- loses nothing. The FIFOs are only flushed at
// the end of a latch with no new STREAM in progress (leftovers of a malformed
// frame). The round-robin demux realigns at the start of every STREAM.
//
// frame_done is the host pacing signal: HIGH only while the FSM is idle with
// every FIFO empty and no STREAM in progress, i.e. after every active port has
// shifted out its last bit AND the latch has run. A host that starts each STREAM
// only after its rising edge can never merge two frames (see README, "Frame-done
// pacing"). It stays HIGH through WRITE_CSR transactions.
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

  // Widths: cnt is [AW:0] (AW+1 bits), wptr/rptr are [AW-1:0] (AW bits). Size the
  // DEPTH comparison/wrap constants to the operand width so the compares don't
  // silently widen to 32-bit int (values are unchanged; DEPTH <= 2**AW).
  assign count = cnt;
  assign empty = (cnt == {(AW + 1) {1'b0}});
  assign full  = (cnt == (AW + 1)'(DEPTH));

  wire do_wr = wr_en && (cnt != (AW + 1)'(DEPTH));
  wire do_rd = rd_en && (cnt != {(AW + 1) {1'b0}});

  always @(posedge clk) begin
    if (clr) begin
      wptr <= {AW{1'b0}};
      rptr <= {AW{1'b0}};
      cnt  <= {(AW + 1) {1'b0}};
    end else begin
      if (do_wr) begin
        mem[wptr] <= wr_data;
        wptr <= (wptr == AW'(DEPTH - 1)) ? {AW{1'b0}} : wptr + 1'b1;
      end
      if (do_rd) begin
        rd_data <= mem[rptr];
        rptr <= (rptr == AW'(DEPTH - 1)) ? {AW{1'b0}} : rptr + 1'b1;
      end
      cnt <= cnt + {{AW{1'b0}}, do_wr} - {{AW{1'b0}}, do_rd};
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
    // WS2812/WS2812B latch is >50us; 80us keeps a full 60Hz/550-LED (and
    // 120Hz/270-LED) frame inside its refresh budget. Too short for WS2813 (280us).
    parameter integer RESET_NS  = 80000,
    parameter integer PREFILL   = 2,     // bytes/port buffered before emit starts
    // Per-port FIFO depth in bytes; 0 = one full frame (MAX_LEDS*3).
    parameter integer FIFO_DEPTH = 0,
    // Latch/reset LOW for led_type 1 (WS2812B-V5 / SK6812-class parts need
    // >= 280 us); led_type 0 keeps RESET_NS (classic WS2812/B, > 50 us).
    parameter integer RESET_ALT_NS = 300000,
    // Self-instrumentation (underrun counters, min FIFO level). 0 = none.
    parameter integer STATS = 0
) (
    input  wire                 clk,
    input  wire                 rst,
    input  wire [          7:0] num_ports,
    input  wire [          7:0] led_type,      // reserved; WS281x only for now
    input  wire [          7:0] stream_byte,
    input  wire                 stream_valid,
    input  wire                 stream_active,
    output reg  [MAX_PORTS-1:0] ws,
    output reg                  frame_pulse,  // 1-cycle strobe when a frame starts
    // Level, registered: HIGH = the previous frame has fully shifted out on every
    // port AND its latch (reset LOW) has elapsed, and no STREAM is in progress.
    // Falls when the next STREAM starts (stream_active, one byte after CS-low);
    // rises 2 clk after the latch ends. The host paces frames on its rising edge.
    output reg                  frame_done,
    // STATS (all 0 when STATS == 0). Cumulative since reset; no read-back yet.
    output reg                  underrun,     // 1-cycle strobe: a FIFO ran dry mid-frame
    output reg  [         15:0] underruns,    // saturating count of those stalls
    output reg  [         15:0] min_fill,     // lowest active-FIFO level seen while streaming
    output wire [8*MAX_PORTS-1:0] port_underruns  // per-port 8-bit saturating counts
);
  localparam integer DEPTH = (FIFO_DEPTH > 0) ? FIFO_DEPTH : MAX_LEDS * 3;
  localparam integer AW = $clog2(DEPTH);
  localparam integer T0H = T0H_NS * CLK_MHZ / 1000;
  localparam integer T1H = T1H_NS * CLK_MHZ / 1000;
  localparam integer PERIOD = PERIOD_NS * CLK_MHZ / 1000;
  localparam integer RESET_TICKS = RESET_NS * CLK_MHZ / 1000;
  localparam integer RESET_ALT_TICKS = RESET_ALT_NS * CLK_MHZ / 1000;
  localparam integer RESET_MAX = (RESET_ALT_TICKS > RESET_TICKS) ? RESET_ALT_TICKS : RESET_TICKS;
  localparam integer CNT_W = $clog2(RESET_MAX + 1);

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
  // led_type selects the latch length (CSR 0x01): 0 = RESET_NS, 1 = RESET_ALT_NS.
  wire [CNT_W-1:0] reset_last = (led_type == 8'd1) ? CNT_W'(RESET_ALT_TICKS - 1) : CNT_W'(RESET_TICKS - 1);
  reg  arrived;  // a new STREAM began during this latch
  reg  sa_q;     // stream_active, delayed (STREAM-start edge)
  // Demux select: port 0 on the cycle a STREAM starts (even if its first byte
  // lands that same cycle), else the running round-robin pointer.
  wire [7:0] wr_sel = (stream_active && !sa_q) ? 8'd0 : wr_port;
  wire flush = (state == S_RESET) && (cnt == reset_last) && !arrived && !stream_active;

  wire [7:0]  fdout [0:MAX_PORTS-1];
  wire [AW:0] fcnt  [0:MAX_PORTS-1];
  wire        fempty[0:MAX_PORTS-1];

  generate
    for (gi = 0; gi < MAX_PORTS; gi = gi + 1) begin : g_fifo
      wire wr = stream_valid && (wr_sel == gi) && active_mask[gi];
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

  // ---- self-instrumentation (STATS) ---------------------------------------
  // An underrun = a byte boundary where some active FIFO is empty while the
  // host is still streaming (the FSM then parks the line LOW in S_WAIT).
  wire stall_now = (state == S_DRIVE) && (cnt == CNT_W'(PERIOD - 1)) && (bit_idx == 3'd7) &&
                   !all_ne && stream_active;
  generate
    if (STATS != 0) begin : g_stats
      reg [7:0] pcnt[0:MAX_PORTS-1];
      integer sp;
      always @(posedge clk) begin
        underrun <= 1'b0;
        if (rst) begin
          underruns <= 16'd0;
          min_fill  <= 16'hFFFF;
          for (sp = 0; sp < MAX_PORTS; sp = sp + 1) pcnt[sp] <= 8'd0;
        end else begin
          if (stall_now) begin
            underrun <= 1'b1;
            if (underruns != 16'hFFFF) underruns <= underruns + 16'd1;
            for (sp = 0; sp < MAX_PORTS; sp = sp + 1)
              if (active_mask[sp] && fempty[sp] && pcnt[sp] != 8'hFF) pcnt[sp] <= pcnt[sp] + 8'd1;
          end
          // Lowest lead while streaming: sampled when the FSM is about to pop.
          if (state == S_POP && stream_active)
            for (sp = 0; sp < MAX_PORTS; sp = sp + 1)
              if (active_mask[sp] && 16'(fcnt[sp]) < min_fill) min_fill <= 16'(fcnt[sp]);
        end
      end
      for (gi = 0; gi < MAX_PORTS; gi = gi + 1) begin : g_pc
        assign port_underruns[8*gi+:8] = pcnt[gi];
      end
    end else begin : g_nostats
      always @(posedge clk) begin
        underrun  <= 1'b0;
        underruns <= 16'd0;
        min_fill  <= 16'd0;
      end
      assign port_underruns = '0;
    end
  endgenerate

`ifdef VERILATOR
  // Simulation-only instrumentation (not synthesized): sticky overflow (a byte
  // arrived for a full FIFO and was dropped), peak fill across ports, and the
  // number of S_WAIT underflow stalls. Read hierarchically by the testbenches.
  reg         ovf = 1'b0;
  reg  [AW:0] max_fill = '0;
  integer     stalls = 0;
  integer     si;
  always @(posedge clk) begin
    for (si = 0; si < MAX_PORTS; si = si + 1) begin
      if (stream_valid && (wr_port == 8'(si)) && active_mask[si] &&
          fcnt[si] == (AW + 1)'(DEPTH))
        ovf <= 1'b1;
      if (fcnt[si] > max_fill) max_fill <= fcnt[si];
    end
    if (state == S_DRIVE && cnt == CNT_W'(PERIOD - 1) && bit_idx == 3'd7 && !all_ne && stream_active)
      stalls <= stalls + 1;
  end
`endif

  // Reductions over active ports: prefill met / no active FIFO empty.
  reg all_pre, all_ne, any_ne;
  integer j;
  always @(*) begin
    all_pre = 1'b1;
    all_ne  = 1'b1;
    any_ne  = 1'b0;
    for (j = 0; j < MAX_PORTS; j = j + 1)
      if (j < num_ports) begin
        if (fcnt[j] < (AW + 1)'(PREFILL)) all_pre = 1'b0;
        if (fempty[j]) all_ne = 1'b0;
        else any_ne = 1'b1;
      end
  end

  reg [7:0] cur [0:MAX_PORTS-1];
  integer   i;

  always @(posedge clk) begin
    frame_pulse <= 1'b0;  // default: single-cycle strobe
    if (rst) begin
      state   <= S_IDLE;
      cnt     <= 0;
      bit_idx <= 3'd0;
      wr_port <= 8'd0;
      ws      <= {MAX_PORTS{1'b0}};
      arrived <= 1'b0;
      sa_q    <= 1'b0;
      frame_done <= 1'b0;
    end else begin
      sa_q <= stream_active;
      // Pacing level. In S_IDLE with no STREAM and every FIFO empty, the last
      // frame (if any) has emitted and latched. If a STREAM began during the latch,
      // stream_active or buffered bytes (any_ne) keep it LOW: that frame starts at
      // once instead.
      frame_done <= (state == S_IDLE) && !stream_active && !any_ne;
      // SPI byte -> round-robin demux pointer; realigned at every STREAM start.
      if (stream_valid) wr_port <= (wr_sel == num_ports - 8'd1) ? 8'd0 : wr_sel + 8'd1;
      else if (stream_active && !sa_q) wr_port <= 8'd0;
      if (state != S_RESET) arrived <= 1'b0;
      else if (stream_active) arrived <= 1'b1;

      case (state)
        S_IDLE: begin
          ws <= {MAX_PORTS{1'b0}};
          // Start once every active port has PREFILL bytes -- or, if CS already
          // ended, with whatever arrived: a frame shorter than PREFILL bytes/port
          // would otherwise never start (and be flushed by the next frame).
          if ((stream_active && all_pre) || (!stream_active && any_ne)) begin
            state       <= S_POP;
            frame_pulse <= 1'b1;  // a new frame begins driving
          end
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
            ws[i] <= active_mask[i] & (cnt < CNT_W'(cur[i][7] ? T1H : T0H));
          if (cnt == CNT_W'(PERIOD - 1)) begin
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
          // Drain-before-reset: emit any buffered byte even if the stream just
          // ended, so a byte that lands as CS deasserts isn't flushed. Only reset
          // once every active FIFO is truly empty.
          if (all_ne) state <= S_POP;
          else if (!stream_active) state <= S_RESET;
        end
        S_RESET: begin
          ws <= {MAX_PORTS{1'b0}};
          if (cnt == reset_last) begin
            cnt     <= 0;
            state   <= S_IDLE;
          end else cnt <= cnt + 1'b1;
        end
        default: state <= S_IDLE;
      endcase
    end
  end
endmodule
