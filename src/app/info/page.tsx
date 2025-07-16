'use client';
import { useState, useRef, useEffect } from 'react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';
const SUPPORTED_TYPES = [
  'application/pdf',
  'text/html',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown'
];

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

interface UploadedFile {
  id: string;
  name?: string;
  key?: string;
  type?: string;
  contentType?: string;
  size?: number;
  uploadedAt?: string;
  createdAt?: string;
  status?: string;
  sentToBotpress?: boolean;
  tags?: {
    purpose?: string;
    origin?: string;
    [key: string]: any;
  };
}

export default function DocumentsPage() {
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error' | ''>('');
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debug backend URL
  console.log('🔧 Backend URL:', BACKEND_URL);

  useEffect(() => {
    fetchFiles();
  }, []);

  const goBack = () => {
    window.location.href = '/';
  };

  const fetchFiles = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${BACKEND_URL}/api/files`);
      if (response.ok) {
        const data = await response.json();
        console.log('📂 Fetched files:', data);
        console.log('📂 Files array:', data.files);
        console.log('📂 Number of files:', data.files ? data.files.length : 0);
        
        // Log each file structure
        if (data.files && data.files.length > 0) {
          console.log('📂 First file structure:', data.files[0]);
        }
        
        setFiles(data.files || []);
      } else {
        console.error('Failed to fetch files:', response.status, response.statusText);
        const errorData = await response.json();
        console.error('Error details:', errorData);
      }
    } catch (error) {
      console.error('Failed to fetch files:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const showMessage = (text: string, type: 'success' | 'error') => {
    setMessage(text);
    setMessageType(type);
    setTimeout(() => {
      setMessage('');
      setMessageType('');
    }, 5000);
  };

  const convertToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        // Remove the data:mime/type;base64, prefix
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleFiles = async (fileList: FileList) => {
    const file = fileList[0]; // Handle one file at a time for now
    
    if (!file) return;

    console.log('📁 File selected:', file.name, file.type, file.size);

    // Validate file type
    if (!SUPPORTED_TYPES.includes(file.type)) {
      showMessage(`Unsupported file type: ${file.type}. Supported formats: PDF, HTML, TXT, DOC, DOCX, MD`, 'error');
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      showMessage(`File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max size: 100MB`, 'error');
      return;
    }

    // Add file to local storage (not sent to Botpress yet)
    setUploadedFiles(prev => {
      const newFiles = [...prev, file];
      console.log('📤 Upload queue updated:', newFiles.length, 'files');
      return newFiles;
    });
    showMessage(`File "${file.name}" added to upload queue!`, 'success');
  };

  const sendToBotpress = async () => {
    if (uploadedFiles.length === 0) {
      showMessage('No files to send to Botpress!', 'error');
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      for (let i = 0; i < uploadedFiles.length; i++) {
        const file = uploadedFiles[i];
        const progress = ((i + 1) / uploadedFiles.length) * 100;
        setUploadProgress(progress);
        
        console.log(`📤 Sending file ${i + 1}/${uploadedFiles.length}: ${file.name}`);
        
        // Convert to base64
        const base64Content = await convertToBase64(file);
        
        // Upload to backend
        const response = await fetch(`${BACKEND_URL}/api/upload-file`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: file.name,
            type: file.type,
            content: base64Content
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`Failed to upload ${file.name}: ${errorData.error || 'Upload failed'}`);
        }

        const result = await response.json();
        console.log(`✅ File ${file.name} uploaded successfully via ${result.method || 'unknown'} API`);
      }
      
      setUploadProgress(100);
      showMessage(`Successfully sent ${uploadedFiles.length} file(s) to Botpress!`, 'success');
      
      // Clear uploaded files and refresh the list
      setUploadedFiles([]);
      await fetchFiles(); // Wait for the fetch to complete

    } catch (error) {
      console.error('Send to Botpress error:', error);
      showMessage(`Failed to send files: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  const deleteFile = async (fileId: string, fileName: string) => {
    if (!confirm(`Are you sure you want to delete "${fileName}"?`)) return;

    try {
      console.log(`🗑️ Deleting file: ${fileName} (ID: ${fileId})`);
      console.log(`🌐 Delete URL: ${BACKEND_URL}/api/files/${fileId}`);
      
      const response = await fetch(`${BACKEND_URL}/api/files/${fileId}`, {
        method: 'DELETE'
      });

      console.log(`📡 Delete response status: ${response.status} ${response.statusText}`);

      const responseData = await response.json();
      console.log('🗑️ Delete response data:', responseData);

      if (!response.ok) {
        throw new Error(responseData.error || responseData.message || 'Delete failed');
      }

      showMessage(`File "${fileName}" deleted successfully via ${responseData.method || 'unknown'} API!`, 'success');
      
      // Remove from local state immediately for better UX
      setFiles(prev => {
        const newFiles = prev.filter(f => f.id !== fileId);
        console.log(`🗑️ Removed file from local state. New count: ${newFiles.length}`);
        return newFiles;
      });
      
      // Also refresh from server after a short delay to ensure consistency
      setTimeout(async () => {
        console.log('🔄 Refreshing files from server...');
        await fetchFiles();
      }, 2000);

    } catch (error) {
      console.error('❌ Delete error:', error);
      showMessage(`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  };

  const removeFromQueue = (index: number) => {
    const file = uploadedFiles[index];
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
    showMessage(`Removed "${file.name}" from upload queue`, 'success');
  };

  return (
    <div className="info-container">
      <div className="documents-content">
        <div className="documents-header">
          <h1>📄 Add Documents</h1>
          <button 
            className="back-button"
            onClick={goBack}
            title="Back to Chat"
          >
            ← Back to Chat
          </button>
        </div>

        {message && (
          <div className={`message ${messageType}`}>
            {message}
          </div>
        )}

        {/* File Upload Area */}
        <div 
          className={`upload-area ${dragActive ? 'drag-active' : ''} ${uploading ? 'uploading' : ''}`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={handleFileSelect}
        >
          <input 
            ref={fileInputRef}
            type="file"
            accept=".pdf,.html,.txt,.doc,.docx,.md"
            onChange={handleFileInput}
            style={{ display: 'none' }}
          />
          
          {uploading ? (
            <div className="upload-progress">
              <div className="progress-bar">
                <div 
                  className="progress-fill" 
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
              <p>Uploading... {uploadProgress}%</p>
            </div>
          ) : (
            <>
              <div className="upload-icon">📁</div>
              <h3>Drag and drop documents here or click to select</h3>
              <p>Supported formats: PDF, HTML, TXT, DOC, DOCX, MD (Max 100MB)</p>
            </>
          )}
        </div>

        {/* Upload Queue - Always show if there are files */}
        {(() => {
          console.log('🔍 Debug: uploadedFiles.length =', uploadedFiles.length);
          console.log('🔍 Debug: uploadedFiles =', uploadedFiles);
          return uploadedFiles.length > 0 && (
            <div className="upload-queue-section">
              <h2>📤 Upload Queue ({uploadedFiles.length})</h2>
              <div className="upload-queue">
                {uploadedFiles.map((file, index) => (
                  <div key={`queue-${index}`} className="queue-item">
                    <div className="file-info">
                      <div className="file-name">📄 {file.name}</div>
                      <div className="file-meta">
                        Type: {file.type} • Size: {(file.size / 1024).toFixed(1)}KB
                      </div>
                    </div>
                    <button 
                      className="remove-button"
                      onClick={() => removeFromQueue(index)}
                      title="Remove from queue"
                    >
                      ❌
                    </button>
                  </div>
                ))}
              </div>
              <button 
                className="send-to-botpress-button"
                onClick={sendToBotpress}
                disabled={uploading}
              >
                {uploading ? '📤 Sending...' : `📤 Send ${uploadedFiles.length} File(s) to Botpress`}
              </button>
            </div>
          );
        })()}

        {/* Debug Section - Remove this after fixing */}
        <div style={{ 
          background: '#f0f0f0', 
          padding: '10px', 
          margin: '10px 0', 
          borderRadius: '5px', 
          fontSize: '12px',
          border: '1px solid #ccc'
        }}>
          <strong>Debug Info:</strong><br/>
          Uploaded Files Count: {uploadedFiles.length}<br/>
          Files in Botpress: {files.length}<br/>
          Is Loading: {isLoading.toString()}<br/>
          Is Uploading: {uploading.toString()}<br/>
          Upload Progress: {uploadProgress}%<br/>
          Backend URL: {BACKEND_URL || 'NOT SET'}<br/>
          <button 
            onClick={() => {
              const testFile = new File(['test content'], 'test.txt', { type: 'text/plain' });
              setUploadedFiles(prev => [...prev, testFile]);
              console.log('🧪 Test file added to queue');
            }}
            style={{ marginTop: '5px', padding: '5px 10px', marginRight: '5px' }}
          >
            Add Test File
          </button>
          <button 
            onClick={async () => {
              console.log('🧪 Testing upload directly...');
              const testFile = new File(['This is a test document content for Botpress.'], 'test-document.txt', { type: 'text/plain' });
              const base64Content = await convertToBase64(testFile);
              
              try {
                const response = await fetch(`${BACKEND_URL}/api/upload-file`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    name: testFile.name,
                    type: testFile.type,
                    content: base64Content
                  })
                });

                const result = await response.json();
                console.log('🧪 Direct upload result:', result);
                
                if (response.ok) {
                  showMessage('Test upload successful!', 'success');
                  await fetchFiles(); // Refresh the list
                } else {
                  showMessage(`Test upload failed: ${result.error}`, 'error');
                }
              } catch (error) {
                console.error('🧪 Test upload error:', error);
                showMessage(`Test upload error: ${error}`, 'error');
              }
            }}
            style={{ marginTop: '5px', padding: '5px 10px' }}
          >
            Test Upload
          </button>
        </div>

        {/* Uploaded Files List */}
        <div className="files-section">
          <h2>📋 Documents in Botpress ({files.length})</h2>
          {isLoading ? (
            <div className="loading-files">
              <p>Loading documents...</p>
            </div>
          ) : files.length === 0 ? (
            <div className="no-files">
              <p>No documents in Botpress yet. Upload files above and send them to Botpress!</p>
            </div>
          ) : (
            <div className="files-list">
              {files.map((file) => (
                <div key={file.id} className="file-item">
                  <div className="file-info">
                    <div className="file-name">
                      📄 {file.name || file.key || `File ${file.id}`}
                    </div>
                    <div className="file-meta">
                      Type: {file.contentType || file.type || 'Unknown'} 
                      {file.size && ` • Size: ${(file.size / 1024).toFixed(1)}KB`}
                      {file.createdAt && ` • Created: ${new Date(file.createdAt).toLocaleDateString()}`}
                      {file.status && ` • Status: ${file.status}`}
                    </div>
                    {file.tags && file.tags.purpose && (
                      <div className="file-tags">
                        Purpose: {file.tags.purpose} • Origin: {file.tags.origin || 'Unknown'}
                      </div>
                    )}
                  </div>
                  <button 
                    className="delete-button"
                    onClick={() => deleteFile(file.id, file.name || file.key || `File ${file.id}`)}
                    title="Delete file"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 