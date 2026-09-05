#!/usr/bin/env node

/**
 * Test script for nurse roster parser and feasibility checker
 * Run with: node test.js
 */

import fs from 'node:fs';

// ============================================================================
// CORE LOGIC (duplicate from HTML for testing)
// ============================================================================

class RosterData {
    constructor() {
        this.nursesData = [];
        this.locked = {};
    }
    
    addNurse(name) {
        const idx = this.nursesData.length;
        this.nursesData.push({
            name: name,
            shifts: []
        });
        return idx;
    }
    
    setShift(dayIndex, nurseIndex, shift) {
        if (!this.nursesData[nurseIndex]) return;
        if (!this.nursesData[nurseIndex].shifts[dayIndex]) {
            this.nursesData[nurseIndex].shifts[dayIndex] = null;
        }
        this.nursesData[nurseIndex].shifts[dayIndex] = shift;
    }
    
    getShift(dayIndex, nurseIndex) {
        if (!this.nursesData[nurseIndex]) return null;
        return this.nursesData[nurseIndex].shifts[dayIndex] || null;
    }
}

function normalizeShift(s) {
    if (!s) return null;
    s = s.toLowerCase().trim();
    if (s === 'x') return null;
    if (s === 'ช' || s === 'c') return 'M';
    if (s === 'บ' || s === 'b' || s === 'a') return 'A';
    if (s === 'ด' || s === 'd' || s === 'n') return 'N';
    if (s === 'r') return 'R';
    if (s === 'o') return 'O';
    if (s === 'v') return 'V';
    if (s === 't') return 'T';
    return null;
}

function parseTextData(text, numDays) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const rosterData = new RosterData();
    const errors = [];
    
    let i = 0;
    while (i < lines.length) {
        const nameLine = lines[i];
        const dataLine = lines[i + 1];
        
        if (!dataLine) {
            errors.push(`Line ${i + 1}: Missing data after name`);
            break;
        }
        
        const nameMatch = nameLine.match(/^\d+\.\s*(.+)$/);
        if (!nameMatch) {
            errors.push(`Line ${i + 1}: Invalid name format`);
            i += 2;
            continue;
        }
        
        const name = nameMatch[1];
        const shifts = dataLine.split('/').map(s => normalizeShift(s));
        
        if (shifts.length !== numDays) {
            errors.push(`${name}: has ${shifts.length} cells, need ${numDays}`);
        }
        
        const nurseIdx = rosterData.addNurse(name);
        rosterData.nursesData[nurseIdx].shifts = shifts.slice(0, numDays);
        
        i += 2;
    }
    
    return { rosterData, errors };
}

function countShiftOnDay(rosterData, dayIndex, shiftType) {
    let count = 0;
    for (let i = 0; i < rosterData.nursesData.length; i++) {
        if (rosterData.getShift(dayIndex, i) === shiftType) count++;
    }
    return count;
}

function checkFeasibility(rosterData, config) {
    const numPeople = rosterData.nursesData.length;
    const numDays = config.numDays;
    const goalM = config.goalMorning;
    const goalA = config.goalAfternoon;
    const goalN = config.goalNight;
    const totalShifts = (goalM + goalA + goalN) * numDays;
    
    const result = {
        totalShiftsNeeded: totalShifts,
        totalWorkDaysAvailable: 0,
        totalDoubleShiftsNeeded: 0,
        avgDoubleShiftsPerPerson: 0,
        violations: [],
        daysWithManyOff: []
    };
    
    // Count work days per person
    // Formula: days - off - vacation - training
    // Note: vacationInQuota config affects QUOTA, not work-day calculation
    // Work days = days available to work (excluding all types of off/leave/training)
    const workDaysPerPerson = [];
    for (let i = 0; i < numPeople; i++) {
        let count = 0;
        for (let d = 0; d < numDays; d++) {
            const shift = rosterData.getShift(d, i);
            // Days that are NOT work days:
            if (shift === 'R' || shift === 'O' || shift === 'V' || shift === 'T') {
                continue;
            }
            // Otherwise: M/A/N (locked shifts) or empty (x) = work days
            count++;
        }
        workDaysPerPerson.push(count);
        result.totalWorkDaysAvailable += count;
    }
    
    result.totalDoubleShiftsNeeded = result.totalShiftsNeeded - result.totalWorkDaysAvailable;
    result.avgDoubleShiftsPerPerson = (result.totalDoubleShiftsNeeded / numPeople).toFixed(1);
    
    // Check locked days constraints
    const lockedDaysPerPerson = [];
    for (let i = 0; i < numPeople; i++) {
        let rCount = 0;
        let vCount = 0;
        for (let d = 0; d < numDays; d++) {
            const shift = rosterData.getShift(d, i);
            if (shift === 'R') rCount++;
            if (shift === 'V') vCount++;
        }
        lockedDaysPerPerson.push(rCount);
        
        if (rCount > config.quotaDays && !config.ignoreLockedOverQuota) {
            result.violations.push({
                type: 'overQuota',
                person: i,
                personName: rosterData.nursesData[i].name,
                count: rCount,
                quota: config.quotaDays
            });
        }
    }
    
    // Check if locked shifts conflict
    for (let d = 0; d < numDays; d++) {
        const mCount = countShiftOnDay(rosterData, d, 'M');
        const aCount = countShiftOnDay(rosterData, d, 'A');
        const nCount = countShiftOnDay(rosterData, d, 'N');
        
        if (mCount > goalM) {
            result.violations.push({
                type: 'tooManyShifts',
                day: d,
                shiftType: 'M',
                count: mCount,
                goal: goalM
            });
        }
        if (aCount > goalA) {
            result.violations.push({
                type: 'tooManyShifts',
                day: d,
                shiftType: 'A',
                count: aCount,
                goal: goalA
            });
        }
        if (nCount > goalN) {
            result.violations.push({
                type: 'tooManyShifts',
                day: d,
                shiftType: 'N',
                count: nCount,
                goal: goalN
            });
        }
        
        // Check days with many people off
        const offCount = countDayOffs(rosterData, d);
        if (offCount >= 3) {
            result.daysWithManyOff.push({ day: d, offCount: offCount, availableWorkers: numPeople - offCount });
        }
    }
    
    // Check night-to-morning conflicts
    if (config.nightToMorning === 'forbidden') {
        for (let i = 0; i < numPeople; i++) {
            for (let d = 0; d < numDays - 1; d++) {
                const today = rosterData.getShift(d, i);
                const tomorrow = rosterData.getShift(d + 1, i);
                if (today === 'N' && tomorrow === 'M') {
                    result.violations.push({
                        type: 'nightToMorning',
                        personName: rosterData.nursesData[i].name,
                        person: i,
                        day: d
                    });
                }
            }
        }
    }
    
    // Check consecutive work days limit
    for (let i = 0; i < numPeople; i++) {
        let maxConsec = 0;
        let curConsec = 0;
        for (let d = 0; d < numDays; d++) {
            const shift = rosterData.getShift(d, i);
            if (shift && shift !== 'R' && shift !== 'O' && shift !== 'V' && shift !== 'T') {
                curConsec++;
                maxConsec = Math.max(maxConsec, curConsec);
            } else {
                curConsec = 0;
            }
        }
        if (maxConsec > config.consecutiveWorkLimit) {
            result.violations.push({
                type: 'tooManyConsecutiveWork',
                personName: rosterData.nursesData[i].name,
                person: i,
                count: maxConsec,
                limit: config.consecutiveWorkLimit
            });
        }
    }
    
    return result;
}

function countDayOffs(rosterData, dayIndex) {
    let count = 0;
    for (let i = 0; i < rosterData.nursesData.length; i++) {
        const shift = rosterData.getShift(dayIndex, i);
        if (shift === 'R' || shift === 'O' || shift === 'V') {
            count++;
        }
    }
    return count;
}

// ============================================================================
// TEST CASE
// ============================================================================

const sampleData = `1.พยาบาล A
บ/x/x/x/x/x/ช/ช/r/r/r/r/ด/ด/x/x/x/x/r/ด/ด/x/x/x/x/ช/x/x/x/x
2.พยาบาล B
x/x/ช/r/ด/x/x/x/x/x/x/x/x/x/x/x/x/ช/r/r/ด/x/x/x/x/x/x/x/ช/r
3.พยาบาล C
x/r/ด/ด/x/x/r/r/ด/ด/x/x/r/ด/ด/x/ช/r/r/r/r/ด/r/x/x/x/x/x/r/ด
4.พยาบาล D
x/x/x/x/x/x/x/x/x/x/x/x/ช/r/r/ด/ด/ด/x/x/x/ช/ด/x/x/x/x/x/x/x
5.พยาบาล E
x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/ช/r/r/r/r/v/v
6.พยาบาล F
o/บ/x/x/x/x/x/บ/r/x/x/x/r/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x
7.พยาบาล G
ด/x/x/x/x/r/x/ด/ด/x/x/x/r/x/ด/ด/x/x/ช/r/x/ด/ด/x/x/ช/r/r/r/r
8.พยาบาล H
ด/x/x/x/x/x/x/ด/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/ด/x
9.พยาบาล I
v/v/v/v/v/r/x/x/x/x/x/r/x/x/x/x/x/x/x/x/x/x/x/x/x/r/r/x/x/x`;

const config = {
    numDays: 30,
    startDay: 1,
    goalMorning: 4,
    goalAfternoon: 3,
    goalNight: 2,
    quotaDays: 6,
    vacationInQuota: false,
    trainingInQuota: false,
    ignoreLockedOverQuota: false,
    nightToMorning: 'forbidden',
    consecutiveWorkLimit: 5,
    consecutiveNightLimit: 2
};

// ============================================================================
// RUN TESTS
// ============================================================================

console.log('🧪 Testing Nurse Roster Scheduler\n');
console.log('=' .repeat(60));

// Test 1: Parse data
console.log('\n✓ Test 1: Parsing input data');
console.log('-' .repeat(60));

const { rosterData, errors } = parseTextData(sampleData, config.numDays);

if (errors.length > 0) {
    console.log('❌ Parsing errors:');
    errors.forEach(e => console.log('  •', e));
} else {
    console.log(`✓ Successfully parsed ${rosterData.nursesData.length} nurses`);
    rosterData.nursesData.forEach((nurse, i) => {
        console.log(`  ${i + 1}. ${nurse.name} - ${nurse.shifts.length} days`);
    });
}

// Test 2: Feasibility check
console.log('\n✓ Test 2: Feasibility check');
console.log('-' .repeat(60));

// Debug: count per person
console.log('\nDebug: Work days per person');
let totalEmpty = 0, totalLocked = 0;
for (let i = 0; i < rosterData.nursesData.length; i++) {
    const nurse = rosterData.nursesData[i];
    let count = 0;
    let emptyCount = 0;
    let lockedCount = 0;
    let offCount = 0;
    for (let d = 0; d < config.numDays; d++) {
        const shift = rosterData.getShift(d, i);
        if (shift === 'R' || shift === 'O' || shift === 'V' || shift === 'T') {
            offCount++;
        } else if (shift === 'M' || shift === 'A' || shift === 'N') {
            lockedCount++;
            count++;
        } else {
            emptyCount++;
            count++;
        }
    }
    totalEmpty += emptyCount;
    totalLocked += lockedCount;
    console.log(`  ${i + 1}. ${nurse.name}: ${emptyCount} empty + ${lockedCount} locked = ${count} work, ${offCount} off`);
}
console.log(`\nTotal: ${totalEmpty} empty + ${totalLocked} locked = ${totalEmpty + totalLocked} work days`);
console.log(`(Expected work days: 204, Difference: ${204 - (totalEmpty + totalLocked)})`);

const feasResult = checkFeasibility(rosterData, config);

console.log(`Total shifts needed: ${feasResult.totalShiftsNeeded} (expected: 270)`);
console.log(`  ✓ Match: ${feasResult.totalShiftsNeeded === 270 ? '✓' : '✗'}`);

console.log(`\nAvailable work days: ${feasResult.totalWorkDaysAvailable} (expected: 204)`);
console.log(`  ✓ Match: ${feasResult.totalWorkDaysAvailable === 204 ? '✓' : '✗'}`);

console.log(`\nDouble shifts needed: ${feasResult.totalDoubleShiftsNeeded} (expected: 66)`);
console.log(`  Average per person: ${feasResult.avgDoubleShiftsPerPerson} (expected: 7.3)`);
console.log(`  ✓ Match: ${feasResult.totalDoubleShiftsNeeded === 66 ? '✓' : '✗'}`);

// Test 3: Violations
console.log('\n✓ Test 3: Violation detection');
console.log('-' .repeat(60));

const overQuotaViolations = feasResult.violations.filter(v => v.type === 'overQuota');
const nightToMorningViolations = feasResult.violations.filter(v => v.type === 'nightToMorning');
const tooManyConsecViolations = feasResult.violations.filter(v => v.type === 'tooManyConsecutiveWork');

console.log(`Over quota violations: ${overQuotaViolations.length}`);
overQuotaViolations.forEach(v => {
    console.log(`  • ${v.personName}: ${v.count} days (limit ${v.quota})`);
});
console.log(`  ✓ Should find C with 10 days: ${overQuotaViolations.some(v => v.personName.includes('C') && v.count === 10) ? '✓' : '✗'}`);

console.log(`\nNight-to-morning violations: ${nightToMorningViolations.length}`);
console.log(`  ✓ Should be 0 (none locked): ${nightToMorningViolations.length === 0 ? '✓' : '✗'}`);

console.log(`\nToo many consecutive work violations: ${tooManyConsecViolations.length}`);
tooManyConsecViolations.forEach(v => {
    console.log(`  • ${v.personName}: ${v.count} consecutive (limit ${v.limit})`);
});

// Test 4: Days with many off
console.log('\n✓ Test 4: Days requiring double shifts');
console.log('-' .repeat(60));

console.log(`Days with 3+ people off: ${feasResult.daysWithManyOff.length}`);
feasResult.daysWithManyOff.forEach(d => {
    console.log(`  • Day ${d.day + 1}: ${d.offCount} off, ${d.availableWorkers} available`);
});

const expectedDays = [12, 18, 19, 26, 28, 29]; // 0-indexed: 13, 19, 20, 27, 29, 30
const foundDays = feasResult.daysWithManyOff.map(d => d.day);
console.log(`\n  Expected days (0-indexed): ${expectedDays.join(', ')}`);
console.log(`  Found days: ${foundDays.join(', ')}`);

// Test 5: Detailed violation reporting
console.log('\n✓ Test 5: All violations');
console.log('-' .repeat(60));

if (feasResult.violations.length === 0) {
    console.log('No violations found');
} else {
    console.log(`Total violations: ${feasResult.violations.length}`);
    feasResult.violations.forEach((v, idx) => {
        if (v.type === 'overQuota') {
            console.log(`  ${idx + 1}. ${v.personName}: R overflow (${v.count}/${v.quota})`);
        } else if (v.type === 'tooManyShifts') {
            const shiftName = { 'M': 'ช', 'A': 'บ', 'N': 'ด' }[v.shiftType];
            console.log(`  ${idx + 1}. Day ${v.day + 1}: Too many ${shiftName} (${v.count}/${v.goal})`);
        } else if (v.type === 'nightToMorning') {
            console.log(`  ${idx + 1}. ${v.personName}: Night→Morning day ${v.day + 1}`);
        } else if (v.type === 'tooManyConsecutiveWork') {
            console.log(`  ${idx + 1}. ${v.personName}: ${v.count} consecutive work (limit ${v.limit})`);
        }
    });
}

console.log('\n' + '=' .repeat(60));
console.log('🎯 Test suite complete!\n');

// Summary
console.log('SUMMARY:');
console.log('--------');
const tests = [
    ['Parse data', errors.length === 0],
    ['Total shifts = 270', feasResult.totalShiftsNeeded === 270],
    ['Work days = 204', feasResult.totalWorkDaysAvailable === 204],
    ['Double shifts = 66', feasResult.totalDoubleShiftsNeeded === 66],
    ['Detect C over quota', overQuotaViolations.some(v => v.personName.includes('C') && v.count === 10)],
    ['No N→M violations', nightToMorningViolations.length === 0],
];

let passCount = 0;
tests.forEach(([name, passed]) => {
    console.log(`  ${passed ? '✓' : '✗'} ${name}`);
    if (passed) passCount++;
});

console.log(`\n${passCount}/${tests.length} tests passed`);
