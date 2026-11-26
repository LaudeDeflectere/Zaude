# Zaude Room Impulse Responses (`assets/irs/`)

Drop mono or stereo `.wav` room impulse response (IR) files here to upgrade Zaude's **🔊 Room Acoustics** presets from synthetic `aecho` early reflections to real FFmpeg `afir` convolution reverb automatically.

### Expected Filenames
- `dim-bar.wav` — Warm wooden bar / billiard hall
- `small-office.wav` — Tight small office / back-bar printer nook
- `hallway.wav` — Reflective corridor / hallway
- `outdoor-street.wav` — Subtle open-air / courtyard slapback
- `podcast-booth.wav` — Tight treated vocal booth

### Recommended Free CC BY 4.0 IR Source
Download real recorded room impulse responses from the **MIT Acoustical Reverberation Scene Statistics Survey**:
- https://mcdermottlab.mit.edu/Reverb/IR_Survey.html

Whenever a preset's `.wav` file is present in this folder, Zaude automatically switches to FFmpeg `afir` convolution (`48 kHz` resampled, `apad=pad_dur=2`, `amix=normalize=0`). If a `.wav` file is missing, Zaude seamlessly falls back to its built-in `aecho` + EQ profile.
