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

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setUploadMessage('');
    try {
      // 1. Extract text from the file (simple example for .txt)
      let extractedText = '';
      if (file.type === 'text/plain') {
        extractedText = await file.text();
      } else {
        setUploadMessage('❌ Only .txt files are supported in this demo.');
        setIsUploading(false);
        return;
      }
      // 2. Send extracted text to backend using PUT
      const sessionId = window.localStorage.getItem('sessionId') || Math.random().toString(36).substring(2);
      window.localStorage.setItem('sessionId', sessionId);
      const response = await fetch('http://localhost:3001/upload-text', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          filename: file.name,
          text: extractedText
        })
      });
      if (response.ok) {
        setUploadMessage('✅ File uploaded and text stored for this session!');
      } else {
        setUploadMessage('❌ Upload failed.');
      }
    } catch (err) {
      setUploadMessage('❌ Upload failed.');
    }
    setIsUploading(false);
  };

  // Add a wrapper for the upload button
  const handleUploadClick = () => {
    if (selectedFile) {
      handleUpload(selectedFile);
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
            onClick={handleUploadClick}
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