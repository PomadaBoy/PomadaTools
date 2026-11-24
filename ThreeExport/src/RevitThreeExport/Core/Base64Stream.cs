using System;
using System.IO;

namespace RevitThreeExport.Core
{
    /// <summary>
    /// Write-only stream that writes the base64 text (ASCII, no line breaks) of
    /// everything written to it into an inner stream. Dispose writes the last group
    /// with its padding. Faster than CryptoStream + ToBase64Transform, which converts
    /// 3 bytes per call on .NET Framework.
    /// </summary>
    public sealed class Base64Stream : Stream
    {
        private const int Block = 3 * 16384;
        private readonly Stream _inner;
        private readonly bool _leaveOpen;
        private readonly byte[] _pending = new byte[Block];
        private int _pendingCount;
        private readonly char[] _chars = new char[Block / 3 * 4];
        private readonly byte[] _ascii = new byte[Block / 3 * 4];
        private bool _closed;

        public Base64Stream(Stream inner, bool leaveOpen = false)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _leaveOpen = leaveOpen;
        }

        public long BytesIn { get; private set; }

        public override void Write(byte[] buffer, int offset, int count)
        {
            if (_closed) throw new ObjectDisposedException(nameof(Base64Stream));
            BytesIn += count;
            while (count > 0)
            {
                var n = Math.Min(count, Block - _pendingCount);
                Buffer.BlockCopy(buffer, offset, _pending, _pendingCount, n);
                _pendingCount += n;
                offset += n;
                count -= n;
                if (_pendingCount == Block) Emit(Block);
            }
        }

        public override void WriteByte(byte value)
        {
            _pending[_pendingCount++] = value;
            BytesIn++;
            if (_pendingCount == Block) Emit(Block);
        }

        private void Emit(int n)
        {
            var chars = Convert.ToBase64CharArray(_pending, 0, n, _chars, 0);
            for (var i = 0; i < chars; i++) _ascii[i] = (byte)_chars[i];
            _inner.Write(_ascii, 0, chars);
            _pendingCount = 0;
        }

        /// <summary>Writes the remaining bytes and padding. Nothing can be written after this.</summary>
        public void FlushFinalBlock()
        {
            if (_closed) return;
            if (_pendingCount > 0) Emit(_pendingCount);
            _closed = true;
            _inner.Flush();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                FlushFinalBlock();
                if (!_leaveOpen) _inner.Dispose();
            }
            base.Dispose(disposing);
        }

        public override void Flush() { }   // only whole 3-byte groups can be written before the end
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => !_closed;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
