import type { GeneratedFormProps } from '../../types';

export default function GeneratedForm(props: GeneratedFormProps) {
  const { currentRecord, position, recordDirty, onFieldChange, onNavigate, onSave, onDelete, controlState, fireEvent, rowSources, definition } = props;
  
  const rec = currentRecord || {};
  const f = (name: string) => {
    const key = Object.keys(rec).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? rec[key] : '';
  };
  
  const allowEdits = definition.allow_edits !== 0;
  
  const getControlState = (name: string) => controlState[name] || {};
  
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
          {getControlState('cboEmployee').visible !== false && (
            <select 
              style={{
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
              }}
              disabled={!allowEdits || getControlState('cboEmployee').enabled === false}
              onClick={() => fireEvent('cboEmployee', 'Click')}
            >
              <option value="">Select an option...</option>
              {rowSources['qrycboEmployees'] && rowSources['qrycboEmployees'].rows.map((row: any[], i: number) => (
                <option key={i} value={String(row[0] ?? '')}>{String(row[1] ?? '')}</option>
              ))}
            </select>
          )}
          
          {/* cboEmployee_Label */}
          {getControlState('cboEmployee_Label').visible !== false && (
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
              {getControlState('cboEmployee_Label').caption || 'Select Employee:'}
            </span>
          )}
          
          {/* Auto_Title0 */}
          {getControlState('Auto_Title0').visible !== false && (
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
              {getControlState('Auto_Title0').caption || 'Northwind Login'}
            </span>
          )}
          
          {/* imgNorthwindTradersLogo */}
          {getControlState('imgNorthwindTradersLogo').visible !== false && (
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
          )}
          
          {/* Disclaimer */}
          {getControlState('Disclaimer').visible !== false && (
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
              {getControlState('Disclaimer').caption || 'The example companies, organizations, products, domain names, e-mail addresses, logos, people, places, and events depicted herein are fictitious.  No association with any real company, organization, product, domain name, email address, logo, person, places, or events is intended or should be inferred.'}
            </span>
          )}
          
          {/* cmdLogin */}
          {getControlState('cmdLogin').visible !== false && (
            <button 
              style={{
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
              }}
              disabled={!allowEdits || getControlState('cmdLogin').enabled === false}
              onClick={() => fireEvent('cmdLogin', 'Click')}
            >
              {(() => {
                const caption = getControlState('cmdLogin').caption || '&Login';
                if (caption.includes('&') && !caption.includes('&&')) {
                  const parts = caption.split('&');
                  if (parts.length === 2 && parts[1]) {
                    return <>{parts[0]}<u>{parts[1][0]}</u>{parts[1].slice(1)}</>;
                  }
                }
                return caption.replace('&&', '&');
              })()}
            </button>
          )}
          
          {/* AutoLogin_lbl */}
          {getControlState('AutoLogin_lbl').visible !== false && (
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
              {getControlState('AutoLogin_lbl').caption || 'Don\'t show me this again - automatically log me in'}
            </span>
          )}
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