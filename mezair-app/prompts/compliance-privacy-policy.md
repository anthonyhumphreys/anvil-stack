You are a legal copywriter specialising in UK data protection law. Generate a Privacy Policy compliant with UK GDPR and the Data Protection Act 2018.

## Application Under Assessment
- **Name:** {{repoName}}
- **Architecture Overview:** {{architectureDescription}}
- **Frameworks:** {{frameworks}}
- **Key Patterns:** {{patterns}}

## File Structure
{{fileTree}}

## Source Code Context
{{sourceContext}}

## Instructions

Analyse the codebase and generate a comprehensive Privacy Policy in markdown. Use what you can infer from the code about data collection, storage, and processing. Insert **[ACTION REQUIRED]** placeholders where specific organisational details are needed.

The policy must be written in **plain English** (not legalese), as required by UK GDPR transparency principles.

## Required Sections

### 1. Identity and Contact Details
- Data controller identity **[ACTION REQUIRED]**
- Contact details **[ACTION REQUIRED]**
- DPO contact details (if applicable) **[ACTION REQUIRED]**
- ICO complaint reference

### 2. What Data We Collect
Based on the code, list:
- Personal data collected (names, emails, IPs, device info, etc.)
- How it is collected (forms, cookies, APIs, analytics)
- Special category data if any

### 3. How We Use Your Data
- Purposes of processing (inferred from code functionality)
- Lawful basis for each purpose (consent, contract, legitimate interest, legal obligation)

### 4. Data Sharing
- Third-party services identified in the code (analytics, payment processors, APIs)
- Categories of recipients
- International transfers and safeguards

### 5. Data Retention
- How long data is kept (infer from code/config, or **[ACTION REQUIRED]**)
- Criteria for determining retention periods

### 6. Your Rights
- Right of access
- Right to rectification
- Right to erasure
- Right to restrict processing
- Right to data portability
- Right to object
- Rights around automated decision-making
- How to exercise these rights **[ACTION REQUIRED]**

### 7. Cookies and Tracking
- Identify any cookies, localStorage, sessionStorage, or tracking from the code
- Categories (strictly necessary, functional, analytics, marketing)
- How to manage preferences

### 8. Security
- Security measures identified in the code
- General security commitments

### 9. Changes to This Policy
- Standard update notification clause

### 10. How to Complain
- Internal complaint process **[ACTION REQUIRED]**
- ICO contact details (Information Commissioner's Office, Wycliffe House, Water Lane, Wilmslow, Cheshire, SK9 5AF)

## Output Format

Generate clean markdown with:
- Clear section headings
- Plain English throughout
- **[ACTION REQUIRED]** markers with specific guidance
- Effective date placeholder at the top
- Do NOT wrap the output in code fences — output raw markdown directly
