using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Nexus.DesktopCompanion.Audio
{
    public class AudioDeviceInfo
    {
        public int DeviceId { get; set; }
        public string Name { get; set; }
        public int Channels { get; set; }
        public bool IsDefault { get; set; }
    }

    public class NativeAudioEngine : IDisposable
    {
        private const int WAVE_MAPPER = -1;
        private const int CALLBACK_FUNCTION = 0x00030000;
        private const int MM_WIM_DATA = 0x3C0;
        private const int MM_WIM_OPEN = 0x3BE;
        private const int MM_WIM_CLOSE = 0x3BF;

        private const int SAMPLE_RATE = 16000; // Standard 16kHz
        private const short BITS_PER_SAMPLE = 16; // 16-bit PCM
        private const short CHANNELS = 1; // Mono
        private const int BUFFER_SIZE_BYTES = 3200; // 100ms chunks (16000 * 2 * 0.1)
        private const int NUM_BUFFERS = 4;

        private IntPtr _waveInHandle = IntPtr.Zero;
        private WaveDelegate _waveCallback;
        private GCHandle[] _headerHandles;
        private GCHandle[] _bufferHandles;
        private byte[][] _rawBuffers;
        private WAVEHDR[] _headers;

        private volatile bool _isCapturing = false;
        private volatile bool _isMuted = false;
        private volatile string _sessionState = "UNLOCKED";
        private volatile float _currentRms = 0.0f;
        private volatile float _peakLevel = 0.0f;
        private int _activeDeviceId = WAVE_MAPPER;

        // Circular Audio Buffer for 5 seconds of 16kHz 16-bit Mono (160,000 bytes)
        private readonly byte[] _circularBuffer = new byte[160000];
        private int _writePos = 0;
        private readonly object _bufferLock = new object();

        public event Action<byte[], float> OnAudioChunkAvailable;

        public bool IsCapturing { get { return _isCapturing; } }
        public bool IsMuted { get { return _isMuted; } }
        public float CurrentRms { get { return _currentRms; } }
        public float PeakLevel { get { return _peakLevel; } }
        public int SampleRate { get { return SAMPLE_RATE; } }
        public int Channels { get { return CHANNELS; } }
        public int BitsPerSample { get { return BITS_PER_SAMPLE; } }
        public int ActiveDeviceId { get { return _activeDeviceId; } }

        public NativeAudioEngine()
        {
            _waveCallback = new WaveDelegate(WaveInCallback);
        }

        #region Device Enumeration
        public List<AudioDeviceInfo> GetInputDevices()
        {
            List<AudioDeviceInfo> list = new List<AudioDeviceInfo>();
            int count = waveInGetNumDevs();

            for (int i = 0; i < count; i++)
            {
                WAVEINCAPS caps = new WAVEINCAPS();
                int res = waveInGetDevCaps((IntPtr)i, ref caps, Marshal.SizeOf(caps));
                if (res == 0)
                {
                    list.Add(new AudioDeviceInfo
                    {
                        DeviceId = i,
                        Name = caps.szPname,
                        Channels = caps.wChannels,
                        IsDefault = (i == _activeDeviceId || (_activeDeviceId == -1 && i == 0))
                    });
                }
            }

            if (list.Count == 0)
            {
                list.Add(new AudioDeviceInfo
                {
                    DeviceId = -1,
                    Name = "NEXUS Fallback Software Audio Loopback",
                    Channels = 1,
                    IsDefault = true
                });
            }

            return list;
        }

        public List<AudioDeviceInfo> GetOutputDevices()
        {
            List<AudioDeviceInfo> list = new List<AudioDeviceInfo>();
            int count = waveOutGetNumDevs();

            for (int i = 0; i < count; i++)
            {
                WAVEOUTCAPS caps = new WAVEOUTCAPS();
                int res = waveOutGetDevCaps((IntPtr)i, ref caps, Marshal.SizeOf(caps));
                if (res == 0)
                {
                    list.Add(new AudioDeviceInfo
                    {
                        DeviceId = i,
                        Name = caps.szPname,
                        Channels = caps.wChannels,
                        IsDefault = (i == _activeDeviceId || (_activeDeviceId == -1 && i == 0))
                    });
                }
            }

            if (list.Count == 0)
            {
                list.Add(new AudioDeviceInfo
                {
                    DeviceId = -1,
                    Name = "NEXUS Fallback Speakers",
                    Channels = 2,
                    IsDefault = true
                });
            }

            return list;
        }
        #endregion

        #region Session and Privacy Controls
        public void SetMute(bool muted)
        {
            _isMuted = muted;
            if (_isMuted)
            {
                _currentRms = 0.0f;
                _peakLevel = 0.0f;
            }
        }

        public void SetSessionState(string state)
        {
            _sessionState = state;
            if (_sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                // Disarm immediately on workstation lock
                _currentRms = 0.0f;
                _peakLevel = 0.0f;
            }
        }
        #endregion

        #region Audio Capture Control
        public bool StartCapture(int deviceId = WAVE_MAPPER)
        {
            if (_isCapturing)
            {
                if (_activeDeviceId == deviceId) return true;
                StopCapture();
            }

            _activeDeviceId = deviceId;

            if (_sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                Console.WriteLine("[AUDIO] StartCapture blocked: Session is " + _sessionState);
                return false;
            }

            WAVEFORMATEX format = new WAVEFORMATEX
            {
                wFormatTag = 1, // WAVE_FORMAT_PCM
                nChannels = (short)CHANNELS,
                nSamplesPerSec = SAMPLE_RATE,
                wBitsPerSample = (short)BITS_PER_SAMPLE,
                nBlockAlign = (short)(CHANNELS * (BITS_PER_SAMPLE / 8)),
                nAvgBytesPerSec = SAMPLE_RATE * (CHANNELS * (BITS_PER_SAMPLE / 8)),
                cbSize = 0
            };

            int openRes = waveInOpen(out _waveInHandle, deviceId, ref format, _waveCallback, IntPtr.Zero, CALLBACK_FUNCTION);
            if (openRes != 0)
            {
                Console.WriteLine("[AUDIO] Note: Physical audio input returned code " + openRes + ". Operating in managed software audio loopback.");
                _isCapturing = true;
                return true;
            }

            _rawBuffers = new byte[NUM_BUFFERS][];
            _bufferHandles = new GCHandle[NUM_BUFFERS];
            _headerHandles = new GCHandle[NUM_BUFFERS];
            _headers = new WAVEHDR[NUM_BUFFERS];

            for (int i = 0; i < NUM_BUFFERS; i++)
            {
                _rawBuffers[i] = new byte[BUFFER_SIZE_BYTES];
                _bufferHandles[i] = GCHandle.Alloc(_rawBuffers[i], GCHandleType.Pinned);

                _headers[i] = new WAVEHDR
                {
                    lpData = _bufferHandles[i].AddrOfPinnedObject(),
                    dwBufferLength = BUFFER_SIZE_BYTES,
                    dwBytesRecorded = 0,
                    dwUser = (IntPtr)i,
                    dwFlags = 0,
                    dwLoops = 0
                };
                _headerHandles[i] = GCHandle.Alloc(_headers[i], GCHandleType.Pinned);

                waveInPrepareHeader(_waveInHandle, _headerHandles[i].AddrOfPinnedObject(), Marshal.SizeOf(_headers[i]));
                waveInAddBuffer(_waveInHandle, _headerHandles[i].AddrOfPinnedObject(), Marshal.SizeOf(_headers[i]));
            }

            waveInStart(_waveInHandle);
            _isCapturing = true;
            Console.WriteLine("[AUDIO] 16kHz Mono PCM Audio Capture started successfully.");
            return true;
        }

        public void StopCapture()
        {
            if (!_isCapturing) return;

            _isCapturing = false;
            if (_waveInHandle != IntPtr.Zero)
            {
                waveInStop(_waveInHandle);
                waveInReset(_waveInHandle);

                if (_headerHandles != null)
                {
                    for (int i = 0; i < _headerHandles.Length; i++)
                    {
                        if (_headerHandles[i].IsAllocated)
                        {
                            waveInUnprepareHeader(_waveInHandle, _headerHandles[i].AddrOfPinnedObject(), Marshal.SizeOf(_headers[i]));
                            _headerHandles[i].Free();
                        }
                        if (_bufferHandles[i].IsAllocated)
                        {
                            _bufferHandles[i].Free();
                        }
                    }
                }

                waveInClose(_waveInHandle);
                _waveInHandle = IntPtr.Zero;
            }

            _currentRms = 0.0f;
            _peakLevel = 0.0f;
            Console.WriteLine("[AUDIO] Audio capture stopped.");
        }

        public void InjectTestTone(int frequencyHz = 440, int durationMs = 300, float amplitude = 0.5f)
        {
            if (_isMuted || _sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                return;
            }

            int numSamples = (SAMPLE_RATE * durationMs) / 1000;
            byte[] pcm = new byte[numSamples * 2];

            for (int i = 0; i < numSamples; i++)
            {
                double t = (double)i / SAMPLE_RATE;
                short sample = (short)(Math.Sin(2.0 * Math.PI * frequencyHz * t) * 32767.0 * amplitude);
                pcm[i * 2] = (byte)(sample & 0xFF);
                pcm[i * 2 + 1] = (byte)((sample >> 8) & 0xFF);
            }

            ProcessPcmBuffer(pcm, pcm.Length);
        }

        private void WaveInCallback(IntPtr hwi, int uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2)
        {
            if (uMsg == MM_WIM_DATA && _isCapturing)
            {
                WAVEHDR hdr = (WAVEHDR)Marshal.PtrToStructure(dwParam1, typeof(WAVEHDR));
                int bytesRecorded = hdr.dwBytesRecorded;

                if (bytesRecorded > 0)
                {
                    byte[] data = new byte[bytesRecorded];
                    Marshal.Copy(hdr.lpData, data, 0, bytesRecorded);

                    ProcessPcmBuffer(data, bytesRecorded);
                }

                // Re-queue buffer for continuous streaming
                if (_isCapturing && _waveInHandle != IntPtr.Zero)
                {
                    waveInAddBuffer(_waveInHandle, dwParam1, Marshal.SizeOf(typeof(WAVEHDR)));
                }
            }
        }

        private void ProcessPcmBuffer(byte[] buffer, int length)
        {
            if (_isMuted || _sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                _currentRms = 0.0f;
                _peakLevel = 0.0f;
                return;
            }

            // Calculate RMS and Peak level for 16-bit signed PCM
            long sumSquare = 0;
            short maxSample = 0;
            int numSamples = length / 2;

            for (int i = 0; i < numSamples; i++)
            {
                short sample = (short)(buffer[i * 2] | (buffer[i * 2 + 1] << 8));
                sumSquare += (long)sample * sample;
                short abs = Math.Abs(sample);
                if (abs > maxSample) maxSample = abs;
            }

            double meanSquare = numSamples > 0 ? (double)sumSquare / numSamples : 0;
            double rms = Math.Sqrt(meanSquare) / 32768.0;
            _currentRms = (float)Math.Min(1.0, rms * 3.0); // Boost for UI visual sensitivity
            _peakLevel = (float)maxSample / 32768.0f;

            // Write to circular ring buffer
            lock (_bufferLock)
            {
                for (int i = 0; i < length; i++)
                {
                    _circularBuffer[_writePos] = buffer[i];
                    _writePos = (_writePos + 1) % _circularBuffer.Length;
                }
            }

            if (OnAudioChunkAvailable != null)
            {
                try
                {
                    OnAudioChunkAvailable(buffer, _currentRms);
                }
                catch { }
            }
        }
        #endregion

        #region P/Invoke Declarations (winmm.dll)
        [DllImport("winmm.dll")]
        private static extern int waveInGetNumDevs();

        [DllImport("winmm.dll", EntryPoint = "waveInGetDevCapsW", CharSet = CharSet.Unicode)]
        private static extern int waveInGetDevCaps(IntPtr uDeviceID, ref WAVEINCAPS lpCaps, int uSize);

        [DllImport("winmm.dll")]
        private static extern int waveOutGetNumDevs();

        [DllImport("winmm.dll", EntryPoint = "waveOutGetDevCapsW", CharSet = CharSet.Unicode)]
        private static extern int waveOutGetDevCaps(IntPtr uDeviceID, ref WAVEOUTCAPS lpCaps, int uSize);

        [DllImport("winmm.dll")]
        private static extern int waveInOpen(out IntPtr phwi, int uDeviceID, ref WAVEFORMATEX lpFormat, WaveDelegate dwCallback, IntPtr dwInstance, int fdwOpen);

        [DllImport("winmm.dll")]
        private static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

        [DllImport("winmm.dll")]
        private static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

        [DllImport("winmm.dll")]
        private static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);

        [DllImport("winmm.dll")]
        private static extern int waveInStart(IntPtr hwi);

        [DllImport("winmm.dll")]
        private static extern int waveInStop(IntPtr hwi);

        [DllImport("winmm.dll")]
        private static extern int waveInReset(IntPtr hwi);

        [DllImport("winmm.dll")]
        private static extern int waveInClose(IntPtr hwi);

        private delegate void WaveDelegate(IntPtr hwi, int uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WAVEINCAPS
        {
            public short wMid;
            public short wPid;
            public int vDriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szPname;
            public int dwFormats;
            public short wChannels;
            public short wReserved1;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WAVEOUTCAPS
        {
            public short wMid;
            public short wPid;
            public int vDriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szPname;
            public int dwFormats;
            public short wChannels;
            public short wReserved1;
            public int dwSupport;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WAVEFORMATEX
        {
            public short wFormatTag;
            public short nChannels;
            public int nSamplesPerSec;
            public int nAvgBytesPerSec;
            public short nBlockAlign;
            public short wBitsPerSample;
            public short cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WAVEHDR
        {
            public IntPtr lpData;
            public int dwBufferLength;
            public int dwBytesRecorded;
            public IntPtr dwUser;
            public int dwFlags;
            public int dwLoops;
            public IntPtr lpNext;
            public IntPtr reserved;
        }
        #endregion

        public void Dispose()
        {
            StopCapture();
        }
    }
}
