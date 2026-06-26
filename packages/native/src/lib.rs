#![deny(clippy::all)]

use napi::bindgen_prelude::*;
#[cfg(windows)]
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;

#[cfg(windows)]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[napi(object)]
pub struct SystemAudioChunk {
  pub data: Buffer,
  pub sample_rate: u32,
  pub channels: u16,
  pub sample_format: String,
  pub bits_per_sample: u32,
  pub frames: u32,
}

#[cfg(windows)]
struct NativeSystemAudioChunk {
  data: Vec<u8>,
  sample_rate: u32,
  channels: u16,
  sample_format: String,
  bits_per_sample: u32,
  frames: u32,
}

#[napi]
pub struct SystemAudioCapture {
  #[cfg(windows)]
  stream: Option<cpal::Stream>,
}

#[napi]
impl SystemAudioCapture {
  #[napi]
  pub fn stop(&mut self) {
    #[cfg(windows)]
    {
      self.stream.take();
    }
  }
}

impl Drop for SystemAudioCapture {
  fn drop(&mut self) {
    self.stop();
  }
}

#[napi]
pub fn start_system_audio_capture(
  callback: Function<FnArgs<(SystemAudioChunk,)>, ()>,
) -> Result<SystemAudioCapture> {
  #[cfg(not(windows))]
  {
    let _ = callback;
    return Err(Error::from_reason(
      "System audio capture is only supported on Windows",
    ));
  }

  #[cfg(windows)]
  {
    start_system_audio_capture_windows(callback)
  }
}

#[cfg(windows)]
fn start_system_audio_capture_windows(
  callback: Function<FnArgs<(SystemAudioChunk,)>, ()>,
) -> Result<SystemAudioCapture> {
  let tsfn = callback
    .build_threadsafe_function::<NativeSystemAudioChunk>()
    .max_queue_size::<8>()
    .build_callback(|ctx| {
      let chunk = ctx.value;
      Ok(FnArgs::from((SystemAudioChunk {
        data: Buffer::from(chunk.data),
        sample_rate: chunk.sample_rate,
        channels: chunk.channels,
        sample_format: chunk.sample_format,
        bits_per_sample: chunk.bits_per_sample,
        frames: chunk.frames,
      },)))
    })?;

  let host = cpal::default_host();
  let device = host
    .default_output_device()
    .ok_or_else(|| Error::from_reason("No default output device found"))?;
  let supported_config = device
    .default_output_config()
    .map_err(|error| Error::from_reason(format!("Failed to get default output config: {error}")))?;

  let sample_format = supported_config.sample_format();
  let stream_config = supported_config.config();
  let sample_rate = stream_config.sample_rate;
  let channels = stream_config.channels;
  let sample_format_name = sample_format_name(sample_format).to_string();
  let bits_per_sample = sample_format.bits_per_sample();

  let stream = match sample_format {
    cpal::SampleFormat::I8 => build_system_audio_stream::<i8>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::I16 => build_system_audio_stream::<i16>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::I24 => build_system_audio_stream::<cpal::I24>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::I32 => build_system_audio_stream::<i32>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::I64 => build_system_audio_stream::<i64>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::U8 => build_system_audio_stream::<u8>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::U16 => build_system_audio_stream::<u16>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::U24 => build_system_audio_stream::<cpal::U24>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::U32 => build_system_audio_stream::<u32>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::U64 => build_system_audio_stream::<u64>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::F32 => build_system_audio_stream::<f32>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    cpal::SampleFormat::F64 => build_system_audio_stream::<f64>(
      &device,
      &stream_config,
      tsfn,
      sample_rate,
      channels,
      sample_format_name,
      bits_per_sample,
      system_audio_stream_error,
    ),
    other => Err(Error::from_reason(format!(
      "Unsupported sample format: {other:?}"
    ))),
  }?;

  stream.play().map_err(|error| {
    Error::from_reason(format!("Failed to start system audio capture: {error}"))
  })?;

  Ok(SystemAudioCapture {
    stream: Some(stream),
  })
}

#[cfg(windows)]
fn build_system_audio_stream<T>(
  device: &cpal::Device,
  config: &cpal::StreamConfig,
  callback: napi::threadsafe_function::ThreadsafeFunction<
    NativeSystemAudioChunk,
    (),
    FnArgs<(SystemAudioChunk,)>,
    napi::Status,
    false,
    false,
    8,
  >,
  sample_rate: u32,
  channels: u16,
  sample_format: String,
  bits_per_sample: u32,
  err_fn: fn(cpal::StreamError),
) -> Result<cpal::Stream>
where
  T: cpal::SizedSample + Send + 'static,
{
  let stream = device
    .build_input_stream(
      config,
      move |data: &[T], _| {
        if data.is_empty() {
          return;
        }

        let byte_len = std::mem::size_of_val(data);
        let bytes =
          unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), byte_len) }.to_vec();
        let frames = (data.len() / usize::from(channels)) as u32;

        let _ = callback.call(
          NativeSystemAudioChunk {
            data: bytes,
            sample_rate,
            channels,
            sample_format: sample_format.clone(),
            bits_per_sample,
            frames,
          },
          ThreadsafeFunctionCallMode::NonBlocking,
        );
      },
      err_fn,
      None,
    )
    .map_err(|error| {
      Error::from_reason(format!(
        "Failed to build system audio capture stream: {error}"
      ))
    })?;

  Ok(stream)
}

#[cfg(windows)]
fn system_audio_stream_error(error: cpal::StreamError) {
  eprintln!("System audio capture stream error: {error}");
}

#[cfg(windows)]
fn sample_format_name(format: cpal::SampleFormat) -> &'static str {
  match format {
    cpal::SampleFormat::I8 => "i8",
    cpal::SampleFormat::I16 => "i16",
    cpal::SampleFormat::I24 => "i24",
    cpal::SampleFormat::I32 => "i32",
    cpal::SampleFormat::I64 => "i64",
    cpal::SampleFormat::U8 => "u8",
    cpal::SampleFormat::U16 => "u16",
    cpal::SampleFormat::U24 => "u24",
    cpal::SampleFormat::U32 => "u32",
    cpal::SampleFormat::U64 => "u64",
    cpal::SampleFormat::F32 => "f32",
    cpal::SampleFormat::F64 => "f64",
    _ => "unknown",
  }
}
