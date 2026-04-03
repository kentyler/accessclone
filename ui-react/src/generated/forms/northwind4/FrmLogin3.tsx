import type { GeneratedFormProps } from '../../types';

export default function GeneratedForm(props: GeneratedFormProps) {
  const { currentRecord, position, recordDirty, onFieldChange, onNavigate, onSave, onDelete, controlState, fireEvent } = props;
  
  return (
    <div className="form-canvas view-mode">
      <div style={{ position: 'relative', width: 574, backgroundColor: '#737373' }}>
        {/* Header section */}
        <div style={{ position: 'relative', height: 48, backgroundColor: 'transparent' }}>
          {/* Box254 */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 574,
            height: 16,
            backgroundColor: '#4472c4',
            borderColor: '#000000',
            pointerEvents: 'none',
            zIndex: 0
          }} />
          
          {/* Box255 */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: 16,
            width: 574,
            height: 16,
            backgroundColor: '#ffffff',
            borderColor: '#000000',
            pointerEvents: 'none',
            zIndex: 0
          }} />
          
          {/* Box256 */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: 32,
            width: 574,
            height: 16,
            backgroundColor: '#4472c4',
            borderColor: '#000000',
            pointerEvents: 'none',
            zIndex: 0
          }} />
        </div>

        {/* Detail section */}
        <div style={{ position: 'relative', height: 252, backgroundColor: 'transparent' }}>
          {/* cboEmployee */}
          <select style={{
            position: 'absolute',
            left: 196,
            top: 96,
            width: 240,
            height: 24,
            fontFamily: 'Calibri',
            fontSize: '11pt',
            color: '#000000',
            backgroundColor: '#ffffff',
            borderColor: '#c0c0c0'
          }}>
            <option value="">Select an option...</option>
          </select>
          
          {/* cboEmployee_Label */}
          <span style={{
            position: 'absolute',
            left: 197,
            top: 76,
            width: 240,
            height: 20,
            fontFamily: 'Arial',
            fontSize: '10pt',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center'
          }}>
            Select Employee:
          </span>
          
          {/* Auto_Title0 */}
          <span style={{
            position: 'absolute',
            left: 197,
            top: 20,
            width: 326,
            height: 48,
            fontFamily: 'Trebuchet MS',
            fontSize: '24pt',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center'
          }}>
            Northwind Login
          </span>
          
          {/* imgNorthwindTradersLogo */}
          <div style={{
            position: 'absolute',
            left: 8,
            top: 4,
            width: 171,
            height: 171,
            backgroundColor: '#ffffff',
            borderColor: '#000000',
            border: '1px solid #000000'
          }}>
            <img src="#" alt="NW2Logo256" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          
          {/* Disclaimer */}
          <span style={{
            position: 'absolute',
            left: 12,
            top: 184,
            width: 530,
            height: 60,
            fontFamily: 'Arial',
            fontSize: '8pt',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'flex-start',
            textAlign: 'left',
            lineHeight: '1.2'
          }}>
            The example companies, organizations, products, domain names, e-mail addresses, logos, people, places, and events depicted herein are fictitious.  No association with any real company, organization, product, domain name, email address, logo, person, places, or events is intended or should be inferred.
          </span>
          
          {/* cmdLogin */}
          <button style={{
            position: 'absolute',
            left: 460,
            top: 96,
            width: 68,
            height: 24,
            fontFamily: 'Calibri',
            fontSize: '11pt',
            color: '#000000',
            backgroundColor: '#f2f2f2',
            borderColor: '#000000',
            border: '1px solid #000000'
          }}>
            <u>L</u>ogin
          </button>
          
          {/* AutoLogin_lbl */}
          <span style={{
            position: 'absolute',
            left: 215,
            top: 128,
            width: 297,
            height: 20,
            fontFamily: 'Arial',
            fontSize: '10pt',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center'
          }}>
            Don't show me this again - automatically log me in
          </span>
        </div>

        {/* Footer section */}
        <div style={{ position: 'relative', height: 48, backgroundColor: 'transparent' }}>
          {/* Box56 */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 574,
            height: 16,
            backgroundColor: '#4472c4',
            borderColor: '#000000',
            pointerEvents: 'none',
            zIndex: 0
          }} />
          
          {/* Box57 */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: 16,
            width: 574,
            height: 16,
            backgroundColor: '#ffffff',
            borderColor: '#000000',
            pointerEvents: 'none',
            zIndex: 0
          }} />
          
          {/* Box58 */}
          <div style={{
            position: 'absolute',
            left: 0,
            top: 32,
            width: 574,
            height: 16,
            backgroundColor: '#4472c4',
            borderColor: '#000000',
            pointerEvents: 'none',
            zIndex: 0
          }} />
        </div>
      </div>
    </div>
  );
}