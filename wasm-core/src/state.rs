// A cursor over the flat number array that save states pass through. The layout
// mirrors the SaveState arrays in src/core/gameboy.ts.

pub struct State<'a> {
    buf: &'a mut [f64],
    i: usize,
}

impl<'a> State<'a> {
    pub fn new(buf: &'a mut [f64]) -> Self {
        State { buf, i: 0 }
    }
    pub fn put(&mut self, v: f64) {
        self.buf[self.i] = v;
        self.i += 1;
    }
    pub fn flag(&mut self, b: bool) {
        self.put(if b { 1.0 } else { 0.0 });
    }
    pub fn get(&mut self) -> f64 {
        let v = self.buf[self.i];
        self.i += 1;
        v
    }
    pub fn is(&mut self) -> bool {
        self.get() == 1.0
    }
    pub fn skip(&mut self, n: usize) {
        self.i += n;
    }
}
