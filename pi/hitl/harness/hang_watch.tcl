# OpenOCD (Espressif) script: catch a HARD HANG on the ESP32-C6 before its
# watchdog resets it. Polls FreeRTOS's tick counter over the system bus WITHOUT
# halting; when it stops advancing for $stall_ms (interrupts dead / core wedged),
# halts the core and dumps its registers, HP + LP SRAM, and the PC trail, then
# leaves it halted (so the watchdog can't erase the evidence) and exits.
#
#   hitl-jtag -c "set ticks 0x4085xxxx" -f hang_watch.tcl
# ($ticks = &xTickCount from the flashed ELF.) Stops on /tmp/ram_watch.stop.

if {![info exists ticks]} { error "set ticks <&xTickCount from the ELF>" }
if {![info exists stall_ms]} { set stall_ms 3000 }
set out /tmp/ram_watch

riscv set_command_timeout_sec 20
init
riscv set_mem_access sysbus

proc rd {a} { return [lindex [read_memory $a 32 1] 0] }
proc logline {msg} {
    global out
    set f [open $out/log.txt a]
    puts $f "[clock milliseconds] $msg"
    close $f
}

set last [rd $ticks]
set since [clock milliseconds]
set n 0
logline "watching xTickCount@$ticks from $last"
while {![file exists /tmp/ram_watch.stop]} {
    after 100
    set t [rd $ticks]
    incr n
    if {$t != $last} {
        set last $t
        set since [clock milliseconds]
        continue
    }
    if {[clock milliseconds] - $since >= $stall_ms} {
        logline "STALL: xTickCount stuck at $t for $stall_ms ms; halting"
        halt 3000
        set f [open $out/regs.txt w]
        puts $f [capture "reg"]
        close $f
        # A short PC trail: is it spinning in one place?
        set f [open $out/pcs.txt w]
        for {set i 0} {$i < 16} {incr i} {
            resume
            after 5
            halt 1000
            puts $f [capture "reg pc"]
        }
        close $f
        dump_image $out/hp.bin 0x40800000 0x80000
        dump_image $out/lp.bin 0x50000000 0x4000
        logline "DUMPED; leaving the core halted"
        shutdown
    }
}
logline "stop after $n samples, no stall"
shutdown
