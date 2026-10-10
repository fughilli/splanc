import time
class PhaseClock:
    def __init__(self,now=None):
        self.now=now or time.monotonic;self.started=self.now();self.overall_started=self.started;self.prerequisite_seconds=0.
    def begin_refinement(self):
        self.prerequisite_seconds=self.now()-self.overall_started
        self.started=self.now()
        return self.started
    def elapsed(self):return self.now()-self.started
