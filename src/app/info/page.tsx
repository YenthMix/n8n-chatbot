'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function InfoPage() {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');

  const handleBackToChat = () => {
    router.push('/');
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setUploadMessage('');
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setUploadMessage('Please select a file first');
      return;
    }

    setIsUploading(true);
    setUploadMessage('Uploading...');

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        setUploadMessage('✅ File uploaded successfully to knowledge base!');
        setSelectedFile(null);
        // Reset file input
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        if (fileInput) fileInput.value = '';
      } else {
        const errorData = await response.json();
        setUploadMessage(`❌ Upload failed: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Upload error:', error);
      setUploadMessage('❌ Upload failed: Network error');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="upload-container">
      <button 
        onClick={handleBackToChat}
        className="back-button"
      >
        ← Back to Chat
      </button>

      <div className="upload-content">
        <h1>📄 Upload Document</h1>
        <p>Upload a document to the knowledge base for better chat assistance</p>
        
        <div className="upload-form">
          <div className="file-input-container">
            <input
              type="file"
              id="file-input"
              accept=".pdf,.txt,.docx,.doc"
              onChange={handleFileSelect}
              className="file-input"
            />
            <label htmlFor="file-input" className="file-input-label">
              {selectedFile ? selectedFile.name : 'Choose a file (.pdf, .txt, .docx)'}
            </label>
          </div>

          <button 
            onClick={handleUpload}
            disabled={!selectedFile || isUploading}
            className="upload-button"
          >
            {isUploading ? 'Uploading...' : 'Upload to Knowledge Base'}
          </button>

          {uploadMessage && (
            <div className={`upload-message ${uploadMessage.includes('✅') ? 'success' : uploadMessage.includes('❌') ? 'error' : 'info'}`}>
              {uploadMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 