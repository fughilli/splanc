# OpenOCD (Espressif) script: watch the ESP32-C6 heap's total free bytes WITHOUT
# halting (system-bus reads while the core runs) and, at each new low below
# $thresh (and at least $step below the last dump), halt, dump HP + LP SRAM and
# the CPU registers, and resume. The last dump is a core image taken at (or
# within $step bytes of) the run's minimum heap watermark.
#
#   hitl-jtag -c "set thresh 9000" -c "set heads 0x4085514c" -f ram_watch.tcl
# ($heads = &registered_heaps from the flashed ELF; it moves with every build.)
# Stops when /tmp/ram_watch.stop exists. Outputs under /tmp/ram_watch/.
#
# heap_t layout (heap_caps.c, from DWARF): caps[3] @0, start @12, end @16,
# heap_mux @20, heap (multi_heap_info*) @28, next @32. multi_heap_info:
# free_bytes @4, minimum_free_bytes @8.

if {![info exists thresh]} { set thresh 9000 }
if {![info exists step]} { set step 512 }
if {![info exists heads]} { error "set heads <&registered_heaps from the ELF>" }
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

set heaps {}
set h [rd $heads]
while {$h != 0} {
    lappend heaps [list [rd [expr {$h + 12}]] [rd [expr {$h + 16}]] [rd [expr {$h + 28}]] [rd $h]]
    set h [rd [expr {$h + 32}]]
}
foreach x $heaps { logline [format "heap start=0x%08x end=0x%08x info=0x%08x caps=0x%x" {*}$x] }

set best 0x7fffffff
set dumped 0x7fffffff
set n 0
while {![file exists /tmp/ram_watch.stop]} {
    set sum 0
    set parts {}
    foreach x $heaps {
        set fb [rd [expr {[lindex $x 2] + 4}]]
        set sum [expr {$sum + $fb}]
        lappend parts $fb
    }
    incr n
    if {$sum < $best} {
        set best $sum
        logline "low sum=$sum per_heap=$parts"
        if {$sum < $thresh && $sum <= $dumped - $step} {
            halt 3000
            # Re-read under halt: the dump's own heap state.
            set hs 0
            set hparts {}
            foreach x $heaps {
                set fb [rd [expr {[lindex $x 2] + 4}]]
                set hs [expr {$hs + $fb}]
                lappend hparts $fb
            }
            dump_image $out/hp.bin 0x40800000 0x80000
            dump_image $out/lp.bin 0x50000000 0x4000
            set f [open $out/regs.txt w]
            puts $f [capture "reg"]
            close $f
            resume
            set dumped $hs
            logline "DUMP sum=$hs per_heap=$hparts"
        }
    }
}
logline "stop after $n samples; min sum=$best last_dump=$dumped"
# The firmware's memory-mode tracker counters (LM_MODE, ledmapper_sysmode
# observe::Stats: polls accepted refused refused_by_kind[4] unmodeled state
# last_refusal), read once at the end — no reporting from the DUT itself.
if {[info exists mode] && $mode != 0} {
    logline "LM_MODE [read_memory $mode 32 10]"
}
shutdown
