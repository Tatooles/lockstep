ENTRY(_start)
MEMORY {
  ROM   (rx)  : ORIGIN = 0x08000000, LENGTH = 32M
  IWRAM (rwx) : ORIGIN = 0x03000000, LENGTH = 30K
  EWRAM (rwx) : ORIGIN = 0x02000000, LENGTH = 256K
}
SECTIONS {
  .text : { KEEP(*(.crt0)) *(.text*) *(.rodata*) . = ALIGN(4); } > ROM
  .iwram : { __iwram_start = .; *(.iwram*) *(.data*) . = ALIGN(4); __iwram_end = .; } > IWRAM AT > ROM
  __iwram_lma = LOADADDR(.iwram);
  .bss (NOLOAD) : { __bss_start = .; *(.bss*) *(COMMON) . = ALIGN(4); __bss_end = .; } > IWRAM
  .ewram (NOLOAD) : { *(.ewram*) } > EWRAM
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) *(.comment) *(.ARM.attributes) }
}
