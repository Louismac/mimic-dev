export class MaxiSynthProcessorBase {

  constructor() {
    const voices = 12;
    this.sampleRate = 44100;
    this.DAC = [0];
    this.dcoOut = 0;
    this.dcfOut = 0;
    this.dco = [];
    this.adsr = [];
    this.triggered = [];
    this.released = [];
    for(let i = 0; i < voices; i++)
    {
      this.dco.push(new Module.maxiOsc());
      this.adsr.push(new Module.maxiEnv());
    }
    this.seqPtr = 0;
    this.samplePtr = 0;
    this.sequence = [];
    this.playHead = 0;
    this.loopStartTicks = this.loopStartSamples = 0;
    this.parameters = {};

    if(this.setup !==undefined) {
      this.setup();
    }
  }

  setup() {

  }

    //Find the oscillator to release for freq (for noteoff)
  getTriggeredForFreq(f) {
    let osc;
    for(let i = 0; i < this.triggered.length; i++)
    {
      if(this.triggered[i].f == f)
      {
        osc = this.triggered[i];
        break;
      }
    }
    return osc;
  }

  //Find the oscillator to release for freq (for noteoff)
  getOscToRelease(f) {
    let osc = -1;
    for(let i = 0; i < this.triggered.length; i++)
    {
      if(this.triggered[i].f === f)
      {
        osc = this.triggered[i].o;
        break;
      }
    }
    return osc;
  }

  isFreqTriggered(f) {
    if(this.paramsLoaded())
    {
      if(this.parameters.poly.val == 1)
      {
        return this.triggered.map(a => a.f).includes(f);
      }
      else
      {
        return this.triggered.length > 0;
      }
    }
  }

  //Get next available oscillator
  //Oscillators are not available until they have finished releasing
  getAvailableOsc() {
    let osc = -1;
    let inUse = this.triggered.concat(this.released).map(a => a.o);
    if(inUse.length >= this.dco.length)
    {
      //console.log("all oscs in use, popping release early", inUse.length);
      this.released.shift();
      inUse = this.triggered.concat(this.released).map(a => a.o);
    }
    for(let i = 0; i < this.dco.length; i++)
    {
      if(!inUse.includes(i))
      {
        osc = i;
        break;
      }
    }
    return osc;
  }

  //Dont retrigger if freq already playing
  externalNoteOn(val)
  {
    const freq = val.f === undefined ? 440 : val.f
    const vel = val.v === undefined ? 127 : val.v
    if(!this.isFreqTriggered(freq) && this.paramsLoaded())
    {
      this.handleCmd({cmd:"noteon", f:freq, v:vel});
    }
  }

  //Only release if freq triggered
  externalNoteOff(freq)
  {
    freq = Math.round((freq + Number.EPSILON) * 100) / 100;
    if(this.paramsLoaded())
    {
      if(this.parameters.poly.val == 1)
      {
        const o = this.getOscToRelease(freq);
        if(o >= 0)
        {
          this.handleCmd({cmd:"noteoff", f:freq});
        }
      }
      else
      {
        this.handleCmd({cmd:"noteoff", f:freq});
      }
    }
  }

  handleCmd(nextCmd) {
    if(this.paramsLoaded())
    {
      const f = Math.round((nextCmd.f + Number.EPSILON) * 100) / 100;
      //console.log(nextCmd)
      if(nextCmd.cmd === "noteon")
      {
        if(this.parameters.poly.val == 1)
        {
          this.triggerNoteOn(f, nextCmd.v)
        }
        else
        {
          //console.log("trigger nonpoly", this.parameters.frequency.val, this.parameters.frequency2.val, this.parameters.poly.val)
          this.releaseAll();
          this.triggerNoteOn(this.parameters.frequency.val, nextCmd.v)
          this.triggerNoteOn(this.parameters.frequency2.val, nextCmd.v)
        }
      }
      else if(nextCmd.cmd === "noteoff")
      {
        let release = -1;
        if(this.parameters.poly.val == 1)
        {
          const t = this.getTriggeredForFreq(f);
          if(t !== undefined) {
            this.release(t);
            this.remove(this.triggered, t);
          }
        }
        else
        {
          this.releaseAll();
        }
      }
    }
  }

  release(t) {
    let releaseTime = 1;
    if(this.paramsLoaded())
    {
      releaseTime = this.samplePtr +
        ((this.parameters.release.val / 1000) * this.sampleRate);
    }
    this.adsr[t.o].trigger = 0;
    releaseTime = Math.round(releaseTime)
    this.released.push({f:t.f, o:t.o, off:releaseTime, v:t.v});

  }

  releaseAll() {
    const toRemove = [];
    this.triggered.forEach((t)=>{
      this.release(t)
      toRemove.push(t)
    })
    for(let i = 0; i < toRemove.length; i++)
    {
      this.remove(this.triggered, toRemove[i]);
    }
  }

  triggerNoteOn(freq, vel = 127)
  {
    if(this.paramsLoaded()) {
      const o = this.getAvailableOsc();
      //This will be -1 if no available oscillators
      if(o >= 0)
      {
        //
        this.adsr[o].setAttack(this.parameters.attack.val);
        this.adsr[o].setDecay(this.parameters.decay.val);
        this.adsr[o].setSustain(this.parameters.sustain.val);
        this.adsr[o].setRelease(this.parameters.release.val);
        this.triggered.push({o:o, f:freq, v:vel/127});
        this.adsr[o].trigger = 1;
        //console.log("triggering", freq, o);
      }
    }
  }

  handleLoop() {
	  //Wrap around any release times
    for(let i = 0; i < this.released.length; i++)
    {
      this.released[i].off = this.released[i].off % this.loopSamples;
      //console.log("wrapping round", this.released[i].off, this.released[i].f)
    }
    this.releaseAll();
    //Restart loop
    this.samplePtr = this.loopStartSamples;
    this.seqPtr = 0;
    this.playHead = this.loopStartTicks;
    while(this.doTrig())
    {
      this.seqPtr++;
    }
  }

  //If theres a command to trigger in the sequence
  doTrig() {
    let trig = false;
    if(this.seqPtr < this.sequence.length)
    {
      trig = this.sequence[this.seqPtr].t < this.playHead;
    }
    return trig;
  }

  tick() {
    //console.log(this.playHead, this.loopTicks)
    if(this.playHead >= this.loopTicks)
    {
      //console.log("loop")
      this.handleLoop();
    }
    while(this.doTrig())
    {
      const nextCmd = this.sequence[this.seqPtr];
      this.handleCmd(nextCmd);
      this.seqPtr++;
    }
    this.playHead++;
  }

  remove(array, element) {
    const index = array.indexOf(element);
    array.splice(index, 1);
  }

  removeReleased() {
    let toRemove = [];
    this.released.forEach((o, i)=>{
      //Because of the way maxi adsr works, check envelope has actually
      //finished releasing
      if(this.samplePtr >= (o.off + 1) && o.lastVol < 0.00001)
      {
        //console.log("removing", o.off, o.lastVol)
        toRemove.push(o);
      }
    });
    for(let i = 0; i < toRemove.length; i++)
    {
      this.remove(this.released, toRemove[i]);
    }
  }

  onSample() {
    this.samplePtr++;
    this.removeReleased();
  }

  onStop() {
    this.releaseAll();
  }

  setSequence(seq) {
    this.sequence = seq;
    this.releaseAll();
  }

  paramsLoaded() {
    return Object.keys(this.parameters).length > 0
  }

  //Call signal once then mix in process loop
  signal() {
    if(this.paramsLoaded())
    {
      //setup
      this.setupSignal()
      this.dcoOut = 0;
      const out = this.triggered.concat(this.released);
      for(let o of out)
      {
        const envOut = this.adsr[o.o].adsr(1, this.adsr[o.o].trigger);
        o.lastVol = envOut;
        //Pass in envelope, index, frequency and velocity
        this.dcoOut += this.noteSignal(envOut, o.o, o.f, o.v)
      }
      //Final non-note specific processing
      return this.endSignal(this.dcoOut);
    }
	else {
      //console.log("just 0")
      return 0;
    }
  }

  setupSignal() {

  }

  noteSignal(envOut, o) {
    return 0;
  }

  endSignal() {
    return 0;
  }

  getOscFn(o)
  {
    let oscFn;
    switch(o) {
      case 0:
        oscFn = "sinewave"; break;
      case 1:
        oscFn = "triangle"; break;
      case 2:
        oscFn = "saw"; break;
      case 3:
        oscFn = "square"; break;
      case 4:
        oscFn = "noise"; break;
      default:
        oscFn = "sinewave"; break;
    }
    return oscFn;
  }
}

// class BasicSynth extends MaxiSynthProcessorBase {
//   constructor() {
//     super()
//   }
//
//   setup() {
//
//   }
//
//   setupSignal() {
//
//   }
//
//   noteSignal(envOut, index, freq, vel) {
//     return this.dco[index].square(freq) * envOut * vel * this.parameters.gain.val;
//
//   }
//
//   endSignal(noteOut) {
//     return [noteOut,noteOut];
//   }
//
//
// }

export class DefaultSynth extends MaxiSynthProcessorBase {
  constructor() {
    super()
  }

  setup() {
    this.lfo = new Module.maxiOsc();
    this.dcf = new Module.maxiFilter();
    this.dl = new Module.maxiDelayline();
    this.verb = new Module.maxiFreeVerb()
  }

  //o
  noteSignal(envOut, index, freq, vel) {
    const poly = this.parameters.poly.val == 1;
    const oscFn = this.getOscFn(this.parameters.oscFn.val);
    const pitchMod = (this.parameters.adsrPitchMod.val * envOut) + (this.lfoOut * this.parameters.lfoPitchMod.val);

    const normalise = poly ? this.dco.length : 4.0;
    let lfoVal = this.parameters.lfoAmpMod.val;
    const ampOsc =  ((this.lfoOut + 1 ) / 2)
    let ampMod = (((1-lfoVal) * envOut) + (lfoVal * ampOsc * envOut)) / normalise;
    let f = freq;
    if(!poly)
    {
      if(index % 2 == 0)
      {
        f = this.parameters.frequency.val
      }
      else
      {
        f = this.parameters.frequency2.val
      }
    }

    let osc;
    if(oscFn === "noise")
    {
      osc = this.dco[index].noise();
    }
    else
    {
      osc = this.dco[index][oscFn](f + pitchMod);
    }

    return (osc * ampMod * this.parameters.gain.val * vel);

  }

  endSignal(noteOut) {
    const delay = this.parameters.delay.val;
    const delayMix = this.parameters.delayMix.val;
    this.dlOut = (this.dl.dl(this.dcoOut, delay, 0.5) * delayMix * 3.5) + (this.dcoOut * (1 - delayMix))
    let filterEnv = 1;
    const filterOsc = ((this.lfoOut + 1)/2) * this.parameters.lfoFilterMod.val;
    let cutoff = this.parameters.cutoff.val;
    cutoff = (cutoff * filterEnv) + filterOsc;
    if (cutoff > 3000) {
      cutoff = 3000;
    }
    if (cutoff < 40) {
      cutoff = 40;
    }
    this.dfcOut = this.dcf.lores(this.dlOut, cutoff, 0.5);

    var wet = this.parameters.reverbMix.val;
    if(wet > 0.01) {
      var room = this.parameters.roomSize.val;
      this.reverbOut = (this.verb.play(this.dfcOut, room, 0.2) * wet * 0.3) + (this.dfcOut * (1 - wet))
    }
    else {
      this.reverbOut = this.dfcOut;
    }

    var r = this.parameters.pan.val;
    var l = 1 - this.parameters.pan.val;

    return [this.reverbOut * l, this.reverbOut * r];
  }

  setupSignal() {
    const lfoOscfn = this.getOscFn(this.parameters.lfoOscFn.val);
    if(lfoOscfn === "noise")
    {
      this.lfoOut = this.lfo.noise();
    }
    else
    {
      this.lfoOut = this.lfo[lfoOscfn](this.parameters.lfoFrequency.val);
    }
  }
}
